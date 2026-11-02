import { describe, expect, it } from 'vitest';
import { AuthService } from '../../src/auth/auth-service';
import { PasswordHasher } from '../../src/auth/password';
import type { QueryResultRow } from '../../src/db/query-executor';
import { withFailingAudit } from './failing-audit';
import { createAuthHarness, type AuthHarness } from './harness';

const PASSWORD = 'Str0ngPassw0rd!2026';
const EMAIL = 'owner@example.test';

interface CountRow extends QueryResultRow {
  count: number;
}
interface SessionRow extends QueryResultRow {
  revoked_at: Date | null;
  session_token_hash: string;
  refresh_token_hash: string;
}

async function auditCount(h: AuthHarness): Promise<number> {
  const rows = await h.query<CountRow>('SELECT count(*)::int AS count FROM platform_audit');
  return rows[0]?.count ?? -1;
}

async function session(h: AuthHarness, id: string): Promise<SessionRow> {
  const rows = await h.query<SessionRow>(
    'SELECT revoked_at, session_token_hash, refresh_token_hash FROM sessions WHERE id = $1',
    [id]
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error('session missing');
  }
  return row;
}

/**
 * C-10. A test double makes ONLY the audit INSERT fail. Every security-critical
 * state change must be rolled back together with its audit record.
 */
describe('C-10 — transactional consistency of security mutations and audit', () => {
  it('rolls back logout, refresh, revocation, recovery and login when the audit write fails', async () => {
    const h = await createAuthHarness();
    try {
      const signup = await h.client.call('POST', '/auth/signup', {
        body: { email: EMAIL, password: PASSWORD, displayName: 'Pilot Owner' },
      });
      expect(signup.status).toBe(201);
      const userId = (signup.body as { userId: string }).userId;
      const login = await h.service.login({ identifier: EMAIL, password: PASSWORD });
      const { sessionId, refreshToken } = login.tokens;
      const before = await session(h, sessionId);
      const auditsBefore = await auditCount(h);
      const historyBefore = await h.query<CountRow>(
        'SELECT count(*)::int AS count FROM refresh_token_history'
      );

      const failing = new AuthService({
        executor: withFailingAudit(h.executor),
        passwordHasher: new PasswordHasher(h.pepper),
        verifier: h.verifier,
      });

      // logout
      await expect(failing.logout(sessionId, userId)).rejects.toThrow(
        /simulated audit write failure/
      );
      expect((await session(h, sessionId)).revoked_at).toBeNull();

      // refresh (CAS rotation + history + audit must all roll back)
      await expect(failing.refresh(refreshToken)).rejects.toThrow(/simulated audit write failure/);
      const afterRefresh = await session(h, sessionId);
      expect(afterRefresh.session_token_hash).toBe(before.session_token_hash);
      expect(afterRefresh.refresh_token_hash).toBe(before.refresh_token_hash);
      expect(
        await h.query<CountRow>('SELECT count(*)::int AS count FROM refresh_token_history')
      ).toEqual(historyBefore);

      // session revocation
      await expect(failing.revokeSession(userId, sessionId)).rejects.toThrow(
        /simulated audit write failure/
      );
      expect((await session(h, sessionId)).revoked_at).toBeNull();

      // recovery request (audit-only, but must not leave a partial record)
      await expect(failing.requestPasswordRecovery(EMAIL, null)).rejects.toThrow(
        /simulated audit write failure/
      );

      // failed login counter
      await expect(
        failing.login({ identifier: EMAIL, password: 'definitely-wrong' })
      ).rejects.toThrow(/simulated audit write failure/);
      const credentials = await h.query<{ failed_attempts: number }>(
        'SELECT failed_attempts FROM credentials WHERE user_id = $1',
        [userId]
      );
      expect(credentials[0]?.failed_attempts).toBe(0);

      // successful login (would create a new session)
      await expect(failing.login({ identifier: EMAIL, password: PASSWORD })).rejects.toThrow(
        /simulated audit write failure/
      );
      const sessions = await h.query<CountRow>(
        'SELECT count(*)::int AS count FROM sessions WHERE user_id = $1',
        [userId]
      );
      expect(sessions[0]?.count).toBe(1);

      // No audit row was written by ANY of the failed operations.
      expect(await auditCount(h)).toBe(auditsBefore);

      // Positive control: with a working audit writer the same logout succeeds
      // and produces exactly one new audit record.
      await h.service.logout(sessionId, userId);
      expect((await session(h, sessionId)).revoked_at).not.toBeNull();
      expect(await auditCount(h)).toBe(auditsBefore + 1);
    } finally {
      await h.close();
    }
  });

  it('rolls back token issuance and verification decisions when the audit write fails', async () => {
    const h = await createAuthHarness();
    try {
      const signup = await h.client.call('POST', '/auth/signup', {
        body: { email: EMAIL, password: PASSWORD, displayName: 'Pilot Owner' },
      });
      const ownerId = (signup.body as { userId: string }).userId;
      const adminId = await h.provisionUser('platform_admin', 'admin@example.test', PASSWORD);
      const failing = new AuthService({
        executor: withFailingAudit(h.executor),
        passwordHasher: new PasswordHasher(h.pepper),
        verifier: h.verifier,
      });

      await expect(failing.adminIssueResetToken(adminId, ownerId, {}, null)).rejects.toThrow(
        /simulated audit write failure/
      );
      expect(
        (await h.query<CountRow>('SELECT count(*)::int AS count FROM password_reset_tokens'))[0]
          ?.count
      ).toBe(0);

      await expect(
        failing.verifyIdentity({
          actorUserId: adminId,
          targetUserId: ownerId,
          decision: 'approved',
          evidence: {},
        })
      ).rejects.toThrow(/simulated audit write failure/);
      const state = await h.query<{ identity_status: string }>(
        'SELECT identity_status::text AS identity_status FROM users WHERE id = $1',
        [ownerId]
      );
      expect(state[0]?.identity_status).toBe('unverified');
      expect(
        (
          await h.query<CountRow>(
            "SELECT count(*)::int AS count FROM identity_verifications WHERE decision = 'approved'"
          )
        )[0]?.count
      ).toBe(0);
    } finally {
      await h.close();
    }
  });
});
