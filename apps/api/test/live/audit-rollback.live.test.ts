import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthService } from '../../src/auth/auth-service';
import { AdminAssistedIdentityVerifier } from '../../src/auth/identity-verifier';
import { PasswordHasher } from '../../src/auth/password';
import { migrateUp } from '../../src/db/migrations';
import {
  createPgClientExecutor,
  type QueryExecutor,
  type QueryResultRow,
} from '../../src/db/query-executor';
import { TEST_AUTH_PEPPER } from '../test-env';
import { withFailingAudit } from '../auth/failing-audit';
import { createLiveDatabase, type LiveDatabase } from './live-database';

const PASSWORD = 'Str0ngPassw0rd!2026';

interface CountRow extends QueryResultRow {
  count: number;
}
interface SessionRow extends QueryResultRow {
  revoked_at: Date | null;
  session_token_hash: string;
}

let live: LiveDatabase;
let client: Client;
let executor: QueryExecutor;
let service: AuthService;

beforeAll(async () => {
  live = await createLiveDatabase('auditrollback');
  client = new Client({ connectionString: live.url });
  await client.connect();
  executor = createPgClientExecutor(client);
  await migrateUp(executor);
  service = new AuthService({
    executor,
    passwordHasher: new PasswordHasher(TEST_AUTH_PEPPER),
    verifier: new AdminAssistedIdentityVerifier(),
  });
});

afterAll(async () => {
  await client?.end();
  await live?.close();
});

async function count(sql: string, values: readonly unknown[] = []): Promise<number> {
  const { rows } = await executor.query<CountRow>(sql, values);
  return rows[0]?.count ?? -1;
}

async function freshSession(): Promise<{
  userId: string;
  sessionId: string;
  refreshToken: string;
}> {
  const tag = Math.random().toString(36).slice(2, 10);
  const email = `rollback-${tag}@example.test`;
  const { userId } = await service.signup({
    email,
    password: PASSWORD,
    displayName: 'Rollback Owner',
  });
  const login = await service.login({ identifier: email, password: PASSWORD });
  return { userId, sessionId: login.tokens.sessionId, refreshToken: login.tokens.refreshToken };
}

describe('C-10 — real PostgreSQL transaction rollback on audit failure', () => {
  it('a test-double audit failure rolls back logout, refresh, revocation and login', async () => {
    const { userId, sessionId, refreshToken } = await freshSession();
    const failing = new AuthService({
      executor: withFailingAudit(executor),
      passwordHasher: new PasswordHasher(TEST_AUTH_PEPPER),
      verifier: new AdminAssistedIdentityVerifier(),
    });
    const auditsBefore = await count('SELECT count(*)::int AS count FROM platform_audit');
    const before = await executor.query<SessionRow>(
      'SELECT revoked_at, session_token_hash FROM sessions WHERE id = $1',
      [sessionId]
    );

    await expect(failing.logout(sessionId, userId)).rejects.toThrow(
      /simulated audit write failure/
    );
    await expect(failing.refresh(refreshToken)).rejects.toThrow(/simulated audit write failure/);
    await expect(failing.revokeSession(userId, sessionId)).rejects.toThrow(
      /simulated audit write failure/
    );
    await expect(failing.requestPasswordRecovery('nobody@example.test', null)).rejects.toThrow(
      /simulated audit write failure/
    );
    await expect(
      failing.login({ identifier: 'nobody@example.test', password: 'wrong' })
    ).rejects.toThrow(/simulated audit write failure/);

    const after = await executor.query<SessionRow>(
      'SELECT revoked_at, session_token_hash FROM sessions WHERE id = $1',
      [sessionId]
    );
    expect(after.rows[0]?.revoked_at).toBeNull();
    expect(after.rows[0]?.session_token_hash).toBe(before.rows[0]?.session_token_hash);
    expect(await count('SELECT count(*)::int AS count FROM platform_audit')).toBe(auditsBefore);
    expect(
      await count('SELECT count(*)::int AS count FROM sessions WHERE user_id = $1', [userId])
    ).toBe(1);
  });

  it('a REAL database trigger failure rolls the whole transaction back', async () => {
    const { userId, sessionId } = await freshSession();
    const auditsBefore = await count('SELECT count(*)::int AS count FROM platform_audit');
    await executor.query(
      `CREATE FUNCTION countup_fail_audit_probe() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'injected audit failure'; END $$`
    );
    await executor.query(
      `CREATE TRIGGER platform_audit_inject_failure
         BEFORE INSERT ON platform_audit
         FOR EACH ROW EXECUTE FUNCTION countup_fail_audit_probe()`
    );
    try {
      await expect(service.logout(sessionId, userId)).rejects.toThrow(/injected audit failure/);
      const session = await executor.query<SessionRow>(
        'SELECT revoked_at, session_token_hash FROM sessions WHERE id = $1',
        [sessionId]
      );
      expect(session.rows[0]?.revoked_at).toBeNull();
      expect(await count('SELECT count(*)::int AS count FROM platform_audit')).toBe(auditsBefore);
    } finally {
      await executor.query(
        'DROP TRIGGER IF EXISTS platform_audit_inject_failure ON platform_audit'
      );
      await executor.query('DROP FUNCTION IF EXISTS countup_fail_audit_probe()');
    }
    // Once the failure is removed, the connection/transaction is usable again.
    await service.logout(sessionId, userId);
    const session = await executor.query<SessionRow>(
      'SELECT revoked_at, session_token_hash FROM sessions WHERE id = $1',
      [sessionId]
    );
    expect(session.rows[0]?.revoked_at).not.toBeNull();
    expect(await count('SELECT count(*)::int AS count FROM platform_audit')).toBe(auditsBefore + 1);
  });

  it('an admin verification transition is atomic with its audit record on real PG', async () => {
    const tag = Math.random().toString(36).slice(2, 10);
    const ownerEmail = `verify-${tag}@example.test`;
    const { userId } = await service.signup({
      email: ownerEmail,
      password: PASSWORD,
      displayName: 'Verify Owner',
    });
    const adminEmail = `verify-admin-${tag}@example.test`;
    const { rows: adminRows } = await executor.query<{ id: string }>(
      `INSERT INTO users
         (primary_email, display_name, role, status, identity_status, identity_verified_at)
       VALUES ($1, 'Admin', 'platform_admin', 'active', 'verified', now()) RETURNING id`,
      [adminEmail]
    );
    const adminId = adminRows[0]?.id as string;
    const failing = new AuthService({
      executor: withFailingAudit(executor),
      passwordHasher: new PasswordHasher(TEST_AUTH_PEPPER),
      verifier: new AdminAssistedIdentityVerifier(),
    });
    await expect(
      failing.verifyIdentity({
        actorUserId: adminId,
        targetUserId: userId,
        decision: 'approved',
        evidence: {},
      })
    ).rejects.toThrow(/simulated audit write failure/);
    const state = await executor.query<{
      identity_status: string;
      identity_verified_at: Date | null;
    }>(
      'SELECT identity_status::text AS identity_status, identity_verified_at FROM users WHERE id = $1',
      [userId]
    );
    expect(state.rows[0]?.identity_status).toBe('unverified');
    expect(state.rows[0]?.identity_verified_at).toBeNull();
    expect(
      await count(
        "SELECT count(*)::int AS count FROM identity_verifications WHERE decision = 'approved' AND user_id = $1",
        [userId]
      )
    ).toBe(0);
  });
});
