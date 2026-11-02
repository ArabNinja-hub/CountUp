import { describe, expect, it } from 'vitest';
import type { QueryResultRow } from '../../src/db/query-executor';
import type { SecurityOverrides } from '../../src/auth/security';
import { createAuthHarness, type AuthHarness, type TestClient } from './harness';

const PASSWORD = 'Str0ngPassw0rd!2026';
const NEW_PASSWORD = 'An0therStr0ngPassw0rd!2026';
const EMAIL = 'owner@example.test';

interface UserRow extends QueryResultRow {
  id: string;
  role: string;
  status: string;
  identity_status: string;
  session_version: number;
  identity_verified_by: string | null;
}

interface CredentialRow extends QueryResultRow {
  password_hash: string;
  password_algo: string;
  failed_attempts: number;
  locked_until: Date | null;
}

interface SessionRow extends QueryResultRow {
  id: string;
  session_token_hash: string;
  refresh_token_hash: string;
  revoked_at: Date | null;
  revoke_reason: string | null;
  rotated_at: Date | null;
  absolute_seconds: number;
  idle_seconds: number;
}

interface CountRow extends QueryResultRow {
  count: number;
}

interface AuditRow extends QueryResultRow {
  action: string;
}

async function withHarness<T>(
  fn: (harness: AuthHarness) => Promise<T>,
  overrides: SecurityOverrides = {}
): Promise<T> {
  const harness = await createAuthHarness(overrides);
  try {
    return await fn(harness);
  } finally {
    await harness.close();
  }
}

function signup(
  harness: AuthHarness,
  client: TestClient = harness.client,
  email = EMAIL,
  password = PASSWORD
) {
  return client.call('POST', '/auth/signup', {
    body: { email, password, displayName: 'Pilot Owner' },
  });
}

function login(client: TestClient, identifier = EMAIL, password = PASSWORD) {
  return client.call('POST', '/auth/login', { body: { identifier, password } });
}

function asObject(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

async function getUserId(harness: AuthHarness, email = EMAIL): Promise<string> {
  const rows = await harness.query<UserRow>(
    'SELECT id, role, status, identity_status, session_version, identity_verified_by FROM users WHERE primary_email = $1',
    [email]
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error(`no user for ${email}`);
  }
  return id;
}

async function adminResetToken(harness: AuthHarness, targetUserId: string): Promise<string> {
  const adminEmail = 'platform-admin@example.test';
  await harness.provisionUser('platform_admin', adminEmail, PASSWORD);
  const adminClient = await harness.newClient();
  const adminLogin = await login(adminClient, adminEmail, PASSWORD);
  expect(adminLogin.status).toBe(200);
  const issued = await adminClient.call('POST', `/auth/admin/password-reset/${targetUserId}`, {
    body: { evidence: { channel: 'in_person', verified_by: 'pilot-operator' } },
  });
  expect(issued.status).toBe(200);
  const token = asObject(issued.body).resetToken;
  if (typeof token !== 'string') {
    throw new Error('admin reset did not return a token');
  }
  return token;
}

describe('Phase C — M2 authentication (real PostgreSQL when TEST_DATABASE_URL is set)', () => {
  it('1. successful signup', async () => {
    await withHarness(async (h) => {
      const response = await signup(h);
      expect(response.status).toBe(201);
      const body = asObject(response.body);
      expect(body.identityStatus).toBe('unverified');
      expect(String(body.userId)).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.stringify(body)).not.toContain('password');
      expect(JSON.stringify(body)).not.toContain('sessionToken');

      const users = await h.query<UserRow>(
        'SELECT id, role, status, identity_status, session_version, identity_verified_by FROM users WHERE primary_email = $1',
        [EMAIL]
      );
      expect(users[0]?.role).toBe('owner');
      expect(users[0]?.status).toBe('active');
      expect(users[0]?.identity_status).toBe('unverified');
      const identities = await h.query<{ verified_at: Date | null }>(
        'SELECT verified_at FROM auth_identities WHERE user_id = $1 AND is_primary',
        [users[0]?.id]
      );
      expect(identities[0]?.verified_at).toBeNull();
      const requests = await h.query<{ decision: string }>(
        'SELECT decision FROM identity_verifications WHERE user_id = $1',
        [users[0]?.id]
      );
      expect(requests[0]?.decision).toBe('requested');
    });
  });

  it('2. duplicate identity rejection', async () => {
    await withHarness(async (h) => {
      expect((await signup(h)).status).toBe(201);
      const duplicate = await signup(h);
      expect(duplicate.status).toBe(409);
      expect(asObject(duplicate.body).error).toBe('duplicate_identity');
      const users = await h.query<CountRow>(
        'SELECT count(*)::int AS count FROM users WHERE primary_email = $1',
        [EMAIL]
      );
      expect(users[0]?.count).toBe(1);
    });
  });

  it('3. Argon2id password hashing, unique salt and peppered verification', async () => {
    await withHarness(async (h) => {
      expect((await signup(h)).status).toBe(201);
      expect((await signup(h, h.client, 'second@example.test')).status).toBe(201);
      const rows = await h.query<CredentialRow>(
        'SELECT password_hash, password_algo, failed_attempts, locked_until FROM credentials ORDER BY password_hash'
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]?.password_algo).toBe('argon2id');
      expect(rows[0]?.password_hash).toMatch(/^\$argon2id\$v=19\$/);
      expect(rows[1]?.password_hash).toMatch(/^\$argon2id\$v=19\$/);
      expect(rows[0]?.password_hash).not.toBe(rows[1]?.password_hash);
      expect(rows[0]?.password_hash).not.toContain(PASSWORD);

      const { PasswordHasher } = await import('../../src/auth/password');
      const hasher = new PasswordHasher(h.pepper);
      const stored = rows[0]?.password_hash ?? '';
      expect(await hasher.verifyPassword(stored, PASSWORD)).toBe(true);
      expect(await hasher.verifyPassword(stored, 'wrong-password')).toBe(false);
      const wrongPepper = new PasswordHasher('a-completely-different-pepper');
      expect(await wrongPepper.verifyPassword(stored, PASSWORD)).toBe(false);
    });
  });

  it('4. successful login', async () => {
    await withHarness(async (h) => {
      expect((await signup(h)).status).toBe(201);
      const response = await login(h.client);
      expect(response.status).toBe(200);
      const user = asObject(asObject(response.body).user);
      expect(user.role).toBe('owner');
      expect(user.identityStatus).toBe('unverified');
      expect(JSON.stringify(response.body)).not.toContain('sessionToken');
      expect(JSON.stringify(response.body)).not.toContain('password_hash');
      expect(h.client.getCookie('countup_session')).toBeTypeOf('string');
      expect(h.client.getCookie('countup_refresh')).toBeTypeOf('string');
      const sessions = await h.query<SessionRow>(
        `SELECT id, session_token_hash, refresh_token_hash, revoked_at, revoke_reason, rotated_at,
                EXTRACT(EPOCH FROM (absolute_expires_at - created_at))::int AS absolute_seconds,
                EXTRACT(EPOCH FROM (idle_expires_at - created_at))::int AS idle_seconds
           FROM sessions`
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.absolute_seconds).toBe(30 * 24 * 60 * 60);
      expect(sessions[0]?.idle_seconds).toBe(12 * 60 * 60);
    });
  });

  it('5. incorrect password rejection', async () => {
    await withHarness(async (h) => {
      await signup(h);
      const response = await login(h.client, EMAIL, 'definitely-wrong');
      expect(response.status).toBe(401);
      expect(asObject(response.body).error).toBe('invalid_credentials');
      const credentials = await h.query<CredentialRow>(
        'SELECT password_hash, password_algo, failed_attempts, locked_until FROM credentials'
      );
      expect(credentials[0]?.failed_attempts).toBe(1);
      const audits = await h.query<AuditRow>(
        "SELECT action FROM platform_audit WHERE action = 'auth.login.failed'"
      );
      expect(audits).toHaveLength(1);
    });
  });

  it('6. login lockout after five failed attempts', async () => {
    await withHarness(async (h) => {
      await signup(h);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const failed = await login(h.client, EMAIL, 'definitely-wrong');
        expect(failed.status).toBe(401);
      }
      const fifth = await login(h.client, EMAIL, 'definitely-wrong');
      expect(fifth.status).toBe(429);
      expect(asObject(fifth.body).error).toBe('account_locked');
      const correctButLocked = await login(h.client, EMAIL, PASSWORD);
      expect(correctButLocked.status).toBe(429);
      const credentials = await h.query<CredentialRow>(
        'SELECT password_hash, password_algo, failed_attempts, locked_until FROM credentials'
      );
      expect(credentials[0]?.failed_attempts).toBe(5);
      expect(credentials[0]?.locked_until).not.toBeNull();
    });
  });

  it('7. session creation stores only SHA-256 token hashes', async () => {
    await withHarness(async (h) => {
      await signup(h);
      await login(h.client);
      const rawSession = h.client.getCookie('countup_session') ?? '';
      const rawRefresh = h.client.getCookie('countup_refresh') ?? '';
      const sessions = await h.query<SessionRow>(
        'SELECT id, session_token_hash, refresh_token_hash, revoked_at, revoke_reason, rotated_at, 0 AS absolute_seconds, 0 AS idle_seconds FROM sessions'
      );
      expect(sessions[0]?.session_token_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(sessions[0]?.refresh_token_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(sessions[0]?.session_token_hash).not.toBe(rawSession);
      expect(sessions[0]?.refresh_token_hash).not.toBe(rawRefresh);
    });
  });

  it('8. session persistence across requests', async () => {
    await withHarness(async (h) => {
      await signup(h);
      await login(h.client);
      const first = await h.client.call('GET', '/auth/me');
      const second = await h.client.call('GET', '/auth/me');
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(asObject(asObject(first.body).user).id).toBe(asObject(asObject(second.body).user).id);
    });
  });

  it('9. session refresh rotates both tokens', async () => {
    await withHarness(async (h) => {
      await signup(h);
      await login(h.client);
      const oldSession = h.client.getCookie('countup_session') ?? '';
      const oldRefresh = h.client.getCookie('countup_refresh') ?? '';
      const refreshed = await h.client.call('POST', '/auth/refresh');
      expect(refreshed.status).toBe(200);
      expect(asObject(refreshed.body).rotated).toBe(true);
      expect(h.client.getCookie('countup_session')).not.toBe(oldSession);
      expect(h.client.getCookie('countup_refresh')).not.toBe(oldRefresh);
      const sessions = await h.query<SessionRow>(
        'SELECT id, session_token_hash, refresh_token_hash, revoked_at, revoke_reason, rotated_at, 0 AS absolute_seconds, 0 AS idle_seconds FROM sessions'
      );
      expect(sessions[0]?.rotated_at).not.toBeNull();
      expect(sessions).toHaveLength(1);
    });
  });

  it('10. reuse of an old session token is rejected', async () => {
    await withHarness(async (h) => {
      await signup(h);
      await login(h.client);
      const oldSession = h.client.getCookie('countup_session') ?? '';
      expect((await h.client.call('POST', '/auth/refresh')).status).toBe(200);
      h.client.setCookie('countup_session', oldSession);
      const reused = await h.client.call('GET', '/auth/me');
      expect(reused.status).toBe(401);
      expect(asObject(reused.body).error).toBe('unauthenticated');
    });
  });

  it('11. logout invalidates the session', async () => {
    await withHarness(async (h) => {
      await signup(h);
      await login(h.client);
      const logout = await h.client.call('POST', '/auth/logout');
      expect(logout.status).toBe(200);
      const after = await h.client.call('GET', '/auth/me');
      expect(after.status).toBe(401);
      const sessions = await h.query<SessionRow>(
        'SELECT id, session_token_hash, refresh_token_hash, revoked_at, revoke_reason, rotated_at, 0 AS absolute_seconds, 0 AS idle_seconds FROM sessions'
      );
      expect(sessions[0]?.revoked_at).not.toBeNull();
      expect(sessions[0]?.revoke_reason).toBe('logout');
    });
  });

  it('12. password change (and revocation of other sessions)', async () => {
    await withHarness(async (h) => {
      await signup(h);
      await login(h.client);
      const other = await h.newClient();
      expect((await login(other)).status).toBe(200);
      const changed = await h.client.call('POST', '/auth/password/change', {
        body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      });
      expect(changed.status).toBe(200);
      expect((await login(h.client, EMAIL, PASSWORD)).status).toBe(401);
      expect((await login(h.client, EMAIL, NEW_PASSWORD)).status).toBe(200);
      expect((await other.call('GET', '/auth/me')).status).toBe(401);
    });
  });

  it('13. password recovery (non-revealing request, admin token, single-use confirm)', async () => {
    await withHarness(async (h) => {
      await signup(h);
      const userId = await getUserId(h);
      const existing = await h.client.call('POST', '/auth/password/recovery/request', {
        body: { identifier: EMAIL },
      });
      const missing = await h.client.call('POST', '/auth/password/recovery/request', {
        body: { identifier: 'nobody@example.test' },
      });
      expect(existing.status).toBe(202);
      expect(missing.status).toBe(202);
      expect(existing.body).toEqual(missing.body);

      const token = await adminResetToken(h, userId);
      const tokens = await h.query<{
        token_hash: string;
        is_admin_initiated: boolean;
        initiated_by: string | null;
      }>(
        `SELECT token_hash, is_admin_initiated, initiated_by FROM password_reset_tokens WHERE user_id = $1`,
        [userId]
      );
      expect(tokens[0]?.is_admin_initiated).toBe(true);
      expect(tokens[0]?.initiated_by).not.toBeNull();
      expect(tokens[0]?.token_hash).not.toBe(token);

      const confirmed = await h.client.call('POST', '/auth/password/recovery/confirm', {
        body: { token, newPassword: NEW_PASSWORD },
      });
      expect(confirmed.status).toBe(200);
      const reused = await h.client.call('POST', '/auth/password/recovery/confirm', {
        body: { token, newPassword: NEW_PASSWORD },
      });
      expect(reused.status).toBe(400);
      expect(asObject(reused.body).error).toBe('invalid_token');
      expect((await login(h.client, EMAIL, PASSWORD)).status).toBe(401);
      expect((await login(h.client, EMAIL, NEW_PASSWORD)).status).toBe(200);
      const audits = await h.query<AuditRow>(
        "SELECT action FROM platform_audit WHERE action LIKE 'auth.password_recovery.%' ORDER BY action"
      );
      expect(audits.map((row) => row.action)).toContain('auth.password_recovery.requested');
      expect(audits.map((row) => row.action)).toContain(
        'auth.password_recovery.admin_token_issued'
      );
      expect(audits.map((row) => row.action)).toContain('auth.password_recovery.completed');
    });
  });

  it('14. password reset revokes all existing sessions and bumps session_version', async () => {
    await withHarness(async (h) => {
      await signup(h);
      const userId = await getUserId(h);
      await login(h.client);
      const before = await h.query<UserRow>(
        'SELECT id, role, status, identity_status, session_version, identity_verified_by FROM users WHERE id = $1',
        [userId]
      );
      const token = await adminResetToken(h, userId);
      expect(
        (
          await h.client.call('POST', '/auth/password/recovery/confirm', {
            body: { token, newPassword: NEW_PASSWORD },
          })
        ).status
      ).toBe(200);
      expect((await h.client.call('GET', '/auth/me')).status).toBe(401);
      const after = await h.query<UserRow>(
        'SELECT id, role, status, identity_status, session_version, identity_verified_by FROM users WHERE id = $1',
        [userId]
      );
      expect(after[0]?.session_version).toBe((before[0]?.session_version ?? 0) + 1);
      // Only the reset account's sessions are revoked (the admin's own session,
      // created by the operator handoff, must remain valid).
      const sessions = await h.query<SessionRow>(
        `SELECT id, session_token_hash, refresh_token_hash, revoked_at, revoke_reason, rotated_at,
                0 AS absolute_seconds, 0 AS idle_seconds
           FROM sessions WHERE user_id = $1`,
        [userId]
      );
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions.every((row) => row.revoked_at !== null)).toBe(true);
    });
  });

  it('15. unverified identities cannot access protected resources', async () => {
    await withHarness(async (h) => {
      await signup(h);
      await login(h.client);
      const sessions = await h.client.call('GET', '/auth/sessions');
      expect(sessions.status).toBe(403);
      expect(asObject(sessions.body).error).toBe('unverified_identity');
      // Account basics remain available but expose no shop data.
      expect((await h.client.call('GET', '/auth/me')).status).toBe(200);
    });
  });

  it('16. admin-assisted verification works only via trusted server-side operations', async () => {
    await withHarness(async (h) => {
      await signup(h);
      const ownerId = await getUserId(h);
      await login(h.client);

      const ownerAttempt = await h.client.call(
        'POST',
        `/auth/admin/identity-verifications/${ownerId}/verify`,
        { body: { decision: 'approved', evidence: { forged: true } } }
      );
      expect(ownerAttempt.status).toBe(403);
      await expect(
        h.verifier.decide(h.executor, {
          actorUserId: ownerId,
          targetUserId: ownerId,
          decision: 'approved',
          evidence: {},
        })
      ).rejects.toThrow();

      // Privilege escalation through a request payload is rejected by strict Zod.
      const escalation = await h.client.call('POST', '/auth/signup', {
        body: {
          email: 'escalate@example.test',
          password: PASSWORD,
          displayName: 'Escalate',
          role: 'platform_admin',
        },
      });
      expect(escalation.status).toBe(400);
      expect(asObject(escalation.body).error).toBe('validation_error');

      const adminEmail = 'platform-admin@example.test';
      const adminId = await h.provisionUser('platform_admin', adminEmail, PASSWORD);
      const adminClient = await h.newClient();
      expect((await login(adminClient, adminEmail, PASSWORD)).status).toBe(200);
      const approved = await adminClient.call(
        'POST',
        `/auth/admin/identity-verifications/${ownerId}/verify`,
        { body: { decision: 'approved', evidence: { channel: 'in_person', id_checked: true } } }
      );
      expect(approved.status).toBe(200);
      expect(asObject(approved.body).mechanism).toBe('admin_assisted_v1');

      const users = await h.query<UserRow>(
        'SELECT id, role, status, identity_status, session_version, identity_verified_by FROM users WHERE id = $1',
        [ownerId]
      );
      expect(users[0]?.identity_status).toBe('verified');
      expect(users[0]?.identity_verified_by).toBe(adminId);
      const identities = await h.query<{ verified_at: Date | null }>(
        'SELECT verified_at FROM auth_identities WHERE user_id = $1 AND is_primary',
        [ownerId]
      );
      expect(identities[0]?.verified_at).not.toBeNull();
      const decisions = await h.query<{ decision: string; reviewed_by: string | null }>(
        'SELECT decision, reviewed_by FROM identity_verifications WHERE user_id = $1 ORDER BY created_at',
        [ownerId]
      );
      expect(decisions.map((row) => row.decision)).toEqual(['requested', 'approved']);
      // Owner session now sees the newly verified status on its next request.
      expect((await h.client.call('GET', '/auth/sessions')).status).toBe(200);
    });
  });

  it('17. unauthenticated access returns the correct error', async () => {
    await withHarness(async (h) => {
      const me = await h.client.call('GET', '/auth/me', { sendCookies: false });
      expect(me.status).toBe(401);
      expect(asObject(me.body).error).toBe('unauthenticated');
      const sessions = await h.client.call('GET', '/auth/sessions', { sendCookies: false });
      expect(sessions.status).toBe(401);
      expect(asObject(sessions.body).error).toBe('unauthenticated');
      expect((await h.client.call('GET', '/health/live')).status).toBe(200);
    });
  });

  it('18. owner-only authorization rejects staff/cashier access', async () => {
    await withHarness(async (h) => {
      await h.provisionUser('staff', 'staff@example.test', PASSWORD);
      const staffClient = await h.newClient();
      expect((await login(staffClient, 'staff@example.test', PASSWORD)).status).toBe(200);
      const me = await staffClient.call('GET', '/auth/me');
      expect(me.status).toBe(403);
      expect(asObject(me.body).error).toBe('owner_only');
      const sessions = await staffClient.call('GET', '/auth/sessions');
      expect(sessions.status).toBe(403);
      expect(asObject(sessions.body).error).toBe('owner_only');
    });
  });

  it('19. CSRF protection rejects invalid requests', async () => {
    await withHarness(async (h) => {
      // Sanity: a correctly signed double-submit token is accepted.
      const valid = await signup(h, h.client, EMAIL, PASSWORD);
      expect(valid.status).toBe(201);
      const missing = await h.client.call('POST', '/auth/signup', {
        body: { email: 'csrf@example.test', password: PASSWORD, displayName: 'CSRF' },
        withCsrf: false,
      });
      expect(missing.status).toBe(403);
      expect(asObject(missing.body).error).toBe('invalid_csrf');
      const wrong = await h.client.call('POST', '/auth/signup', {
        body: { email: 'csrf2@example.test', password: PASSWORD, displayName: 'CSRF' },
        headers: { 'x-csrf-token': 'forged.invalid' },
      });
      expect(wrong.status).toBe(403);
    });
  });

  it('20. cross-origin state-changing requests are rejected', async () => {
    await withHarness(async (h) => {
      const evilOrigin = await h.client.call('POST', '/auth/signup', {
        body: { email: EMAIL, password: PASSWORD, displayName: 'Pilot Owner' },
        headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      });
      expect(evilOrigin.status).toBe(403);
      expect(asObject(evilOrigin.body).error).toBe('cross_origin');
      const crossSite = await h.client.call('POST', '/auth/signup', {
        body: { email: EMAIL, password: PASSWORD, displayName: 'Pilot Owner' },
        headers: { 'sec-fetch-site': 'cross-site' },
      });
      expect(crossSite.status).toBe(403);
      const noHeaders = await h.client.call('POST', '/auth/signup', {
        body: { email: EMAIL, password: PASSWORD, displayName: 'Pilot Owner' },
        headers: { origin: '', 'sec-fetch-site': '' },
      });
      expect(noHeaders.status).toBe(403);
      const users = await h.query<CountRow>('SELECT count(*)::int AS count FROM users');
      expect(users[0]?.count).toBe(0);
    });
  });

  it('21. per-IP and per-identity rate limiting works', async () => {
    await withHarness(
      async (h) => {
        await signup(h);
        const first = await login(h.client, EMAIL, 'wrong-1');
        const second = await login(h.client, EMAIL, 'wrong-2');
        expect(first.status).toBe(401);
        expect(second.status).toBe(401);
        const third = await login(h.client, EMAIL, 'wrong-3');
        expect(third.status).toBe(429);
        expect(asObject(third.body).error).toBe('rate_limited');
      },
      {
        rules: {
          loginIp: { max: 2, windowMs: 60_000 },
          loginIdentity: { max: 50, windowMs: 60_000 },
          globalIp: { max: 50, windowMs: 60_000 },
        },
      }
    );
  });

  it('22. session_version invalidation works', async () => {
    await withHarness(async (h) => {
      await signup(h);
      const userId = await getUserId(h);
      await login(h.client);
      await h.service.invalidateAllSessions(userId);
      const after = await h.client.call('GET', '/auth/me');
      expect(after.status).toBe(401);
      const users = await h.query<UserRow>(
        'SELECT id, role, status, identity_status, session_version, identity_verified_by FROM users WHERE id = $1',
        [userId]
      );
      expect(users[0]?.session_version).toBe(1);
      expect((await login(h.client)).status).toBe(200);
      expect((await h.client.call('GET', '/auth/me')).status).toBe(200);
    });
  });

  it('23. session listing/revocation exposes no token hashes', async () => {
    await withHarness(async (h) => {
      await signup(h);
      const userId = await getUserId(h);
      await login(h.client);
      const adminEmail = 'platform-admin@example.test';
      await h.provisionUser('platform_admin', adminEmail, PASSWORD);
      const adminClient = await h.newClient();
      await login(adminClient, adminEmail, PASSWORD);
      const approved = await adminClient.call(
        'POST',
        `/auth/admin/identity-verifications/${userId}/verify`,
        { body: { decision: 'approved', evidence: { channel: 'in_person' } } }
      );
      expect(approved.status).toBe(200);

      const list = await h.client.call('GET', '/auth/sessions');
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).not.toContain('session_token_hash');
      expect(JSON.stringify(list.body)).not.toContain('refresh_token_hash');
      const sessions = asObject(list.body).sessions as Array<Record<string, unknown>>;
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      const sessionId = String(sessions[0]?.id);
      const revoked = await h.client.call('POST', `/auth/sessions/${sessionId}/revoke`);
      expect(revoked.status).toBe(200);
      expect(asObject(revoked.body).revoked).toBe(true);
      expect((await h.client.call('GET', '/auth/me')).status).toBe(401);
    });
  });

  it('24. no private API response caching', async () => {
    await withHarness(async (h) => {
      await signup(h);
      const response = await h.client.call('GET', '/health/live');
      expect(response.headers.get('cache-control')).toContain('no-store');
      const loginResponse = await login(h.client);
      expect(loginResponse.headers.get('cache-control')).toContain('no-store');
    });
  });
});
