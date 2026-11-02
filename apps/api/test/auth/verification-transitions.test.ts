import { describe, expect, it } from 'vitest';
import type { QueryResultRow } from '../../src/db/query-executor';
import { withFailingAudit } from './failing-audit';
import { createAuthHarness, type AuthHarness } from './harness';

const PASSWORD = 'Str0ngPassw0rd!2026';
const EMAIL = 'owner@example.test';
const ADMIN_EMAIL = 'admin@example.test';
const ADMIN2_EMAIL = 'admin2@example.test';

interface UserStateRow extends QueryResultRow {
  identity_status: string;
  identity_verified_at: Date | null;
  identity_verified_by: string | null;
}

interface IdentityRow extends QueryResultRow {
  verified_at: Date | null;
}

async function setup(): Promise<{
  h: AuthHarness;
  ownerId: string;
  adminId: string;
  admin: Awaited<ReturnType<AuthHarness['newClient']>>;
}> {
  const h = await createAuthHarness();
  const signup = await h.client.call('POST', '/auth/signup', {
    body: { email: EMAIL, password: PASSWORD, displayName: 'Pilot Owner' },
  });
  expect(signup.status).toBe(201);
  const ownerId = (signup.body as { userId: string }).userId;
  const adminId = await h.provisionUser('platform_admin', ADMIN_EMAIL, PASSWORD);
  const admin = await h.newClient();
  expect(
    (
      await admin.call('POST', '/auth/login', {
        body: { identifier: ADMIN_EMAIL, password: PASSWORD },
      })
    ).status
  ).toBe(200);
  return { h, ownerId, adminId, admin };
}

function verifyUrl(userId: string): string {
  return `/auth/admin/identity-verifications/${userId}/verify`;
}

describe('C-05 — separation of duties for administrator-tier operations', () => {
  it('forbids self-verification, admin-to-admin verification and privileged self/admin resets', async () => {
    const { h, ownerId, adminId, admin } = await setup();
    try {
      const admin2Id = await h.provisionUser('platform_admin', ADMIN2_EMAIL, PASSWORD);
      const safe = { evidence: { verification_method: 'in_person' } };

      const selfVerify = await admin.call('POST', verifyUrl(adminId), {
        body: { decision: 'approved', ...safe },
      });
      expect(selfVerify.status).toBe(403);
      expect((selfVerify.body as { error: string }).error).toBe('admin_self_action');

      const adminToAdmin = await admin.call('POST', verifyUrl(admin2Id), {
        body: { decision: 'approved', ...safe },
      });
      expect(adminToAdmin.status).toBe(403);
      expect((adminToAdmin.body as { error: string }).error).toBe('admin_tier_protected');

      const selfReset = await admin.call('POST', `/auth/admin/password-reset/${adminId}`, {
        body: safe,
      });
      expect(selfReset.status).toBe(403);
      expect((selfReset.body as { error: string }).error).toBe('admin_self_action');

      const otherAdminReset = await admin.call('POST', `/auth/admin/password-reset/${admin2Id}`, {
        body: safe,
      });
      expect(otherAdminReset.status).toBe(403);
      expect((otherAdminReset.body as { error: string }).error).toBe('admin_tier_protected');

      // Direct service-level calls are protected too.
      await expect(
        h.verifier.decide(h.executor, {
          actorUserId: adminId,
          targetUserId: adminId,
          decision: 'approved',
          evidence: {},
        })
      ).rejects.toThrow();
      await expect(h.service.adminIssueResetToken(adminId, admin2Id, {}, null)).rejects.toThrow();

      // An admin CAN still act on an ordinary owner.
      expect(
        (await admin.call('POST', verifyUrl(ownerId), { body: { decision: 'approved', ...safe } }))
          .status
      ).toBe(200);
      expect(
        (await admin.call('POST', `/auth/admin/password-reset/${ownerId}`, { body: safe })).status
      ).toBe(200);
    } finally {
      await h.close();
    }
  });

  it('self-service recovery never mints a privileged reset token', async () => {
    const h = await createAuthHarness();
    try {
      const response = await h.client.call('POST', '/auth/password/recovery/request', {
        body: { identifier: EMAIL },
      });
      expect(response.status).toBe(202);
      const tokens = await h.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM password_reset_tokens'
      );
      expect(tokens[0]?.count).toBe(0);
    } finally {
      await h.close();
    }
  });
});

describe('C-06 — one authoritative verification state, atomic transitions', () => {
  it('approve -> reject clears every marker and blocks subsequent authorization', async () => {
    const { h, ownerId, adminId, admin } = await setup();
    try {
      expect(
        (
          await h.client.call('POST', '/auth/login', {
            body: { identifier: EMAIL, password: PASSWORD },
          })
        ).status
      ).toBe(200);
      const url = verifyUrl(ownerId);
      const safe = { evidence: { verification_method: 'in_person' } };

      expect(
        (await admin.call('POST', url, { body: { decision: 'approved', ...safe } })).status
      ).toBe(200);
      const approved = await h.query<UserStateRow>(
        'SELECT identity_status, identity_verified_at, identity_verified_by FROM users WHERE id = $1',
        [ownerId]
      );
      expect(approved[0]?.identity_status).toBe('verified');
      expect(approved[0]?.identity_verified_at).not.toBeNull();
      expect(approved[0]?.identity_verified_by).toBe(adminId);
      expect((await h.client.call('GET', '/auth/sessions')).status).toBe(200);

      // Database-level invariant: a non-verified status may not keep markers.
      await expect(
        h.executor.query("UPDATE users SET identity_status = 'unverified' WHERE id = $1", [ownerId])
      ).rejects.toThrow();

      expect(
        (await admin.call('POST', url, { body: { decision: 'rejected', ...safe } })).status
      ).toBe(200);
      const rejected = await h.query<UserStateRow>(
        'SELECT identity_status, identity_verified_at, identity_verified_by FROM users WHERE id = $1',
        [ownerId]
      );
      expect(rejected[0]?.identity_status).toBe('rejected');
      expect(rejected[0]?.identity_verified_at).toBeNull();
      expect(rejected[0]?.identity_verified_by).toBeNull();
      const identities = await h.query<IdentityRow>(
        'SELECT verified_at FROM auth_identities WHERE user_id = $1',
        [ownerId]
      );
      expect(identities.every((row) => row.verified_at === null)).toBe(true);
      // The authoritative status is re-read from PostgreSQL on every request.
      expect((await h.client.call('GET', '/auth/sessions')).status).toBe(403);

      // The trigger forbids re-marking an identity as verified while rejected.
      await expect(
        h.executor.query(
          'UPDATE auth_identities SET verified_at = now() WHERE user_id = $1 AND is_primary',
          [ownerId]
        )
      ).rejects.toThrow();

      // Re-approval restores a fully consistent state (approve -> reject -> approve).
      expect(
        (await admin.call('POST', url, { body: { decision: 'approved', ...safe } })).status
      ).toBe(200);
      const reapproved = await h.query<UserStateRow>(
        'SELECT identity_status, identity_verified_at, identity_verified_by FROM users WHERE id = $1',
        [ownerId]
      );
      expect(reapproved[0]?.identity_status).toBe('verified');
      expect(reapproved[0]?.identity_verified_at).not.toBeNull();
      expect(reapproved[0]?.identity_verified_by).toBe(adminId);
      expect((await h.client.call('GET', '/auth/sessions')).status).toBe(200);

      const decisions = await h.query<{ decision: string }>(
        'SELECT decision FROM identity_verifications WHERE user_id = $1 ORDER BY created_at',
        [ownerId]
      );
      expect(decisions.map((row) => row.decision)).toEqual([
        'requested',
        'approved',
        'rejected',
        'approved',
      ]);
    } finally {
      await h.close();
    }
  });

  it('rejection is atomic: a failed audit write rolls back the whole transition', async () => {
    const { h, ownerId, adminId } = await setup();
    try {
      const failing = withFailingAudit(h.executor);
      await expect(
        h.verifier.decide(failing, {
          actorUserId: adminId,
          targetUserId: ownerId,
          decision: 'approved',
          evidence: {},
        })
      ).rejects.toThrow(/simulated audit write failure/);
      const state = await h.query<UserStateRow>(
        'SELECT identity_status, identity_verified_at, identity_verified_by FROM users WHERE id = $1',
        [ownerId]
      );
      expect(state[0]?.identity_status).toBe('unverified');
      expect(state[0]?.identity_verified_at).toBeNull();
      const decisions = await h.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM identity_verifications WHERE decision = 'approved'"
      );
      expect(decisions[0]?.count).toBe(0);
    } finally {
      await h.close();
    }
  });
});
