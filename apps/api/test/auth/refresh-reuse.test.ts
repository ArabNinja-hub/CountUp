import { describe, expect, it } from 'vitest';
import { hashToken } from '../../src/auth/tokens';
import type { QueryResultRow } from '../../src/db/query-executor';
import { createAuthHarness } from './harness';

const PASSWORD = 'Str0ngPassw0rd!2026';
const EMAIL = 'refresh-reuse@example.test';

interface SessionRow extends QueryResultRow {
  revoked_at: Date | null;
  revoke_reason: string | null;
  session_version: number;
}
interface AuditRow extends QueryResultRow {
  action: string;
}

/** Fast-suite counterpart of the real-PostgreSQL concurrency regression. */
describe('C-01 — refresh-token reuse detection (isolated PGlite)', () => {
  it('a rotated refresh token is dead, and replaying it revokes the family', async () => {
    const h = await createAuthHarness();
    try {
      const signup = await h.client.call('POST', '/auth/signup', {
        body: { email: EMAIL, password: PASSWORD, displayName: 'Refresh Owner' },
      });
      expect(signup.status).toBe(201);
      const userId = (signup.body as { userId: string }).userId;
      const login = await h.service.login({ identifier: EMAIL, password: PASSWORD });
      const oldRefresh = login.tokens.refreshToken;

      const rotated = await h.service.refresh(oldRefresh);
      expect(rotated.refreshToken).not.toBe(oldRefresh);
      await expect(h.service.validateSession(login.tokens.sessionToken)).rejects.toThrow();

      // Compare-and-swap means the old hash can never rotate a second time.
      await expect(h.service.refresh(oldRefresh)).rejects.toThrow();

      const sessions = await h.query<SessionRow>(
        `SELECT s.revoked_at, s.revoke_reason, u.session_version
           FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.user_id = $1`,
        [userId]
      );
      expect(sessions[0]?.revoked_at).not.toBeNull();
      expect(sessions[0]?.revoke_reason).toBe('refresh_token_reuse');
      expect(sessions[0]?.session_version).toBe(1);
      const history = await h.query<{ consumed_at: Date | null; reuse_detected_at: Date | null }>(
        'SELECT consumed_at, reuse_detected_at FROM refresh_token_history WHERE token_hash = $1',
        [hashToken(oldRefresh)]
      );
      expect(history[0]?.consumed_at).not.toBeNull();
      expect(history[0]?.reuse_detected_at).not.toBeNull();
      const audits = await h.query<AuditRow>(
        "SELECT action FROM platform_audit WHERE action = 'auth.session.refresh_reuse_detected'"
      );
      expect(audits).toHaveLength(1);
      // The winner's tokens are also invalidated by the version bump.
      await expect(h.service.validateSession(rotated.sessionToken)).rejects.toThrow();
      await expect(h.service.refresh(rotated.refreshToken)).rejects.toThrow();
    } finally {
      await h.close();
    }
  });

  it('every issued refresh hash is recorded so reuse cannot be bypassed', async () => {
    const h = await createAuthHarness();
    try {
      await h.client.call('POST', '/auth/signup', {
        body: { email: EMAIL, password: PASSWORD, displayName: 'Refresh Owner' },
      });
      const login = await h.service.login({ identifier: EMAIL, password: PASSWORD });
      const first = await h.service.refresh(login.tokens.refreshToken);
      const second = await h.service.refresh(first.refreshToken);
      const history = await h.query<{ token_hash: string; consumed_at: Date | null }>(
        'SELECT token_hash, consumed_at FROM refresh_token_history'
      );
      expect(history).toHaveLength(3);
      expect(history.filter((row) => row.consumed_at !== null)).toHaveLength(2);
      const active = await h.query<{ token_hash: string }>(
        'SELECT token_hash FROM refresh_token_history WHERE consumed_at IS NULL'
      );
      expect(active).toHaveLength(1);
      expect(active[0]?.token_hash).toBe(hashToken(second.refreshToken));
    } finally {
      await h.close();
    }
  });
});
