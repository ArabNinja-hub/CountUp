import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertAuditPayload,
  assertSafeAuditText,
  auditEvidenceSchema,
  parseAuditEvidence,
} from '../../src/auth/audit-evidence';
import { writeSecurityAudit } from '../../src/auth/audit';
import type { QueryResultRow } from '../../src/db/query-executor';
import { createMigratedDatabase } from '../isolated-database';
import { createAuthHarness } from './harness';

const PASSWORD = 'Str0ngPassw0rd!2026';
const DOCUMENT_HASH = createHash('sha256').update('nrc-reference').digest('hex');

interface PayloadRow extends QueryResultRow {
  payload: Record<string, unknown>;
  evidence: Record<string, unknown>;
  action: string;
}

describe('C-09 — strict, bounded audit evidence (unit)', () => {
  const prohibited = [
    { password: 'hunter2' },
    { password_hint: 'first pet' },
    { national_id: '123456/11/1' },
    { raw_email: 'victim@pii.test' },
    { email: 'victim@pii.test' },
    { phone: '+260971234567' },
    { secret: 'abc' },
    { api_token: 'abc' },
    { blob: 'x'.repeat(20_000) },
    { forged: true },
  ];

  it.each(prohibited.map((value) => [JSON.stringify(value).slice(0, 40), value] as const))(
    'rejects prohibited evidence object %s',
    (_label, value) => {
      expect(auditEvidenceSchema.safeParse(value).success).toBe(false);
      expect(() => parseAuditEvidence(value)).toThrow();
      expect(() => assertAuditPayload({ evidence: value })).toThrow();
    }
  );

  it('accepts only bounded allowlisted fields, including hashed references', () => {
    const evidence = {
      verification_method: 'in_person',
      document_type: 'nrc',
      document_reference_hash: DOCUMENT_HASH,
      id_checked: true,
      reviewer_note: 'Identity checked in person',
    };
    expect(parseAuditEvidence(evidence)).toEqual(evidence);
    expect(() => assertAuditPayload({ mechanism: 'admin_assisted_v1', evidence })).not.toThrow();
  });

  it('rejects raw personal identifiers and password hashes in any payload string', () => {
    expect(() => assertSafeAuditText('victim@pii.test')).toThrow();
    expect(() => assertSafeAuditText('123456/11/1')).toThrow();
    expect(() => assertSafeAuditText('+260 97 1234567')).toThrow();
    expect(() => assertSafeAuditText('$argon2id$v=19$abc')).toThrow();
    expect(() => assertSafeAuditText(DOCUMENT_HASH)).not.toThrow();
    expect(() => assertAuditPayload({ raw_email: 'victim@pii.test' })).toThrow();
    expect(() => assertAuditPayload({ blob: 'x'.repeat(20_000) })).toThrow();
    expect(() => assertAuditPayload({ nested: { password: 'x' } })).toThrow();
  });

  it('writeSecurityAudit refuses a forbidden payload before inserting anything', async () => {
    const db = await createMigratedDatabase();
    try {
      await expect(
        writeSecurityAudit(db.executor, {
          action: 'test.forbidden',
          payload: { password_hint: 'hunter2', evidence: { national_id: '123456/11/1' } },
        })
      ).rejects.toThrow();
      const { rows } = await db.executor.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM platform_audit'
      );
      expect(rows[0]?.count).toBe(0);
    } finally {
      await db.close();
    }
  });
});

describe('C-09 — prohibited fields cannot reach append-only tables (HTTP)', () => {
  it('rejects PII at the schema boundary and persists only allowlisted evidence', async () => {
    const h = await createAuthHarness();
    try {
      const signup = await h.client.call('POST', '/auth/signup', {
        body: { email: 'owner@example.test', password: PASSWORD, displayName: 'Pilot Owner' },
      });
      expect(signup.status).toBe(201);
      const ownerId = (signup.body as { userId: string }).userId;
      await h.provisionUser('platform_admin', 'admin@example.test', PASSWORD);
      const admin = await h.newClient();
      expect(
        (
          await admin.call('POST', '/auth/login', {
            body: { identifier: 'admin@example.test', password: PASSWORD },
          })
        ).status
      ).toBe(200);

      const url = `/auth/admin/identity-verifications/${ownerId}/verify`;
      const attackBodies = [
        { decision: 'approved', evidence: { password_hint: 'hunter2' } },
        { decision: 'approved', evidence: { national_id: '123456/11/1' } },
        { decision: 'approved', evidence: { raw_email: 'victim@pii.test' } },
        { decision: 'approved', evidence: { password: 'hunter2' } },
        { decision: 'approved', evidence: { blob: 'x'.repeat(20_000) } },
        { decision: 'approved', notes: 'owner victim@pii.test NRC 123456/11/1' },
        { decision: 'approved', evidence: { forged: true } },
      ];
      for (const body of attackBodies) {
        const result = await admin.call('POST', url, { body });
        expect(result.status, JSON.stringify(body).slice(0, 60)).toBe(400);
        expect((result.body as { error: string }).error).toBe('validation_error');
      }

      const approved = await admin.call('POST', url, {
        body: {
          decision: 'approved',
          evidence: {
            verification_method: 'in_person',
            document_type: 'nrc',
            document_reference_hash: DOCUMENT_HASH,
            id_checked: true,
          },
          notes: 'Checked in person',
        },
      });
      expect(approved.status).toBe(200);

      const rows = await h.query<PayloadRow>(
        `SELECT action, payload, '{}'::jsonb AS evidence FROM platform_audit
          UNION ALL
         SELECT decision AS action, '{}'::jsonb AS payload, evidence FROM identity_verifications`
      );
      const serialised = JSON.stringify(rows);
      for (const forbidden of [
        'hunter2',
        '123456/11/1',
        'victim@pii.test',
        'password_hint',
        'national_id',
        'forged',
        'x'.repeat(100),
      ]) {
        expect(serialised).not.toContain(forbidden);
      }
      const evidenceRows = await h.query<{ evidence: Record<string, unknown> }>(
        "SELECT evidence FROM identity_verifications WHERE decision = 'approved'"
      );
      expect(Object.keys(evidenceRows[0]?.evidence ?? {}).sort()).toEqual(
        ['document_reference_hash', 'document_type', 'id_checked', 'verification_method'].sort()
      );
    } finally {
      await h.close();
    }
  });

  it('rejects prohibited evidence on the admin password-reset path too', async () => {
    const h = await createAuthHarness();
    try {
      const signup = await h.client.call('POST', '/auth/signup', {
        body: { email: 'owner@example.test', password: PASSWORD, displayName: 'Pilot Owner' },
      });
      const ownerId = (signup.body as { userId: string }).userId;
      await h.provisionUser('platform_admin', 'admin@example.test', PASSWORD);
      const admin = await h.newClient();
      await admin.call('POST', '/auth/login', {
        body: { identifier: 'admin@example.test', password: PASSWORD },
      });
      const result = await admin.call('POST', `/auth/admin/password-reset/${ownerId}`, {
        body: { evidence: { national_id: '123456/11/1', password_hint: 'hunter2' } },
      });
      expect(result.status).toBe(400);
      const rows = await h.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM password_reset_tokens'
      );
      expect(rows[0]?.count).toBe(0);
      const audit = await h.query<PayloadRow>(
        "SELECT payload, action, '{}'::jsonb AS evidence FROM platform_audit"
      );
      expect(JSON.stringify(audit)).not.toContain('123456/11/1');
    } finally {
      await h.close();
    }
  });

  it('direct service-level evidence is validated as well (no HTTP schema in front)', async () => {
    const h = await createAuthHarness();
    try {
      const signup = await h.client.call('POST', '/auth/signup', {
        body: { email: 'owner@example.test', password: PASSWORD, displayName: 'Pilot Owner' },
      });
      const ownerId = (signup.body as { userId: string }).userId;
      const adminId = await h.provisionUser('platform_admin', 'admin@example.test', PASSWORD);
      await expect(
        h.verifier.decide(h.executor, {
          actorUserId: adminId,
          targetUserId: ownerId,
          decision: 'approved',
          evidence: { national_id: '123456/11/1', password_hint: 'hunter2' },
        })
      ).rejects.toThrow(/Rejected audit evidence|Rejected audit payload/);
      const decisions = await h.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM identity_verifications WHERE decision = 'approved'"
      );
      expect(decisions[0]?.count).toBe(0);
    } finally {
      await h.close();
    }
  });
});
