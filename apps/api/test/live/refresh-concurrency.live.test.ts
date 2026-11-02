import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthService } from '../../src/auth/auth-service';
import { AdminAssistedIdentityVerifier } from '../../src/auth/identity-verifier';
import { PasswordHasher } from '../../src/auth/password';
import { hashToken } from '../../src/auth/tokens';
import { migrateUp } from '../../src/db/migrations';
import {
  createPgClientExecutor,
  type QueryExecutor,
  type QueryResultRow,
} from '../../src/db/query-executor';
import { TEST_AUTH_PEPPER } from '../test-env';
import { createLiveDatabase, type LiveDatabase } from './live-database';

const PASSWORD = 'Str0ngPassw0rd!2026';

interface CountRow extends QueryResultRow {
  count: number;
}
interface SessionRow extends QueryResultRow {
  revoked_at: Date | null;
  revoke_reason: string | null;
  session_version: number;
}
interface AuditRow extends QueryResultRow {
  action: string;
}

let live: LiveDatabase;
let clientA: Client;
let clientB: Client;
let executorA: QueryExecutor;
let executorB: QueryExecutor;
let serviceA: AuthService;
let serviceB: AuthService;
let userIndex = 0;

function serviceFor(executor: QueryExecutor): AuthService {
  return new AuthService({
    executor,
    passwordHasher: new PasswordHasher(TEST_AUTH_PEPPER),
    verifier: new AdminAssistedIdentityVerifier(),
  });
}

async function newUserWithRefresh(): Promise<{
  userId: string;
  refreshToken: string;
  sessionId: string;
}> {
  userIndex += 1;
  const email = `concurrency-${userIndex}@example.test`;
  const { userId } = await serviceA.signup({
    email,
    password: PASSWORD,
    displayName: 'Concurrency Owner',
  });
  const login = await serviceA.login({ identifier: email, password: PASSWORD });
  return { userId, refreshToken: login.tokens.refreshToken, sessionId: login.tokens.sessionId };
}

async function reuseEvidence(userId: string, oldRefresh: string): Promise<void> {
  const sessions = await executorA.query<SessionRow>(
    `SELECT s.revoked_at, s.revoke_reason, u.session_version
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.user_id = $1`,
    [userId]
  );
  expect(sessions.rows[0]?.revoked_at).not.toBeNull();
  expect(sessions.rows[0]?.revoke_reason).toBe('refresh_token_reuse');
  expect(sessions.rows[0]?.session_version).toBe(1);
  const audits = await executorA.query<AuditRow>(
    "SELECT action FROM platform_audit WHERE action = 'auth.session.refresh_reuse_detected'"
  );
  expect(audits.rows.length).toBeGreaterThan(0);
  const history = await executorA.query<{ reuse_detected_at: Date | null }>(
    'SELECT reuse_detected_at FROM refresh_token_history WHERE token_hash = $1',
    [hashToken(oldRefresh)]
  );
  expect(history.rows[0]?.reuse_detected_at).not.toBeNull();
}

/** Widens the race window by delaying the CAS UPDATE inside a real transaction. */
function withDelayedRotation(executor: QueryExecutor, delayMs: number): QueryExecutor {
  const wrap = (inner: QueryExecutor): QueryExecutor => ({
    async query<Row extends QueryResultRow = QueryResultRow>(
      sql: string,
      values?: readonly unknown[]
    ): Promise<{ rows: Row[] }> {
      if (/UPDATE\s+sessions\s+SET/i.test(sql)) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
      return inner.query<Row>(sql, values);
    },
    async exec(sql: string): Promise<void> {
      return inner.exec(sql);
    },
    transaction<T>(work: (tx: QueryExecutor) => Promise<T>): Promise<T> {
      return inner.transaction((tx) => work(wrap(tx)));
    },
  });
  return wrap(executor);
}

beforeAll(async () => {
  live = await createLiveDatabase('refresh');
  clientA = new Client({ connectionString: live.url });
  clientB = new Client({ connectionString: live.url });
  await Promise.all([clientA.connect(), clientB.connect()]);
  executorA = createPgClientExecutor(clientA);
  executorB = createPgClientExecutor(clientB);
  await migrateUp(executorA);
  serviceA = serviceFor(executorA);
  serviceB = serviceFor(executorB);
});

afterAll(async () => {
  await clientA?.end();
  await clientB?.end();
  await live?.close();
});

describe('C-01 — atomic CAS refresh rotation on real PostgreSQL', () => {
  it('two concurrent refreshes with the same token cannot both succeed', async () => {
    const { userId, refreshToken } = await newUserWithRefresh();
    const results = await Promise.allSettled([
      serviceA.refresh(refreshToken),
      serviceB.refresh(refreshToken),
    ]);
    const succeeded = results.filter((result) => result.status === 'fulfilled');
    const failed = results.filter((result) => result.status === 'rejected');
    expect(succeeded, JSON.stringify(results.map((r) => r.status))).toHaveLength(1);
    expect(failed).toHaveLength(1);
    await reuseEvidence(userId, refreshToken);

    const rotations = await executorA.query<CountRow>(
      "SELECT count(*)::int AS count FROM platform_audit WHERE action = 'auth.session.refreshed'"
    );
    // Exactly one claimed rotation for this user; the loser wrote a reuse alert.
    expect(rotations.rows[0]?.count).toBe(1);
  });

  it('an orchestrated overlap (delayed CAS on both clients) still serialises', async () => {
    const { userId, refreshToken } = await newUserWithRefresh();
    const delayedA = serviceFor(withDelayedRotation(executorA, 90));
    const delayedB = serviceFor(withDelayedRotation(executorB, 90));
    const results = await Promise.allSettled([
      delayedA.refresh(refreshToken),
      delayedB.refresh(refreshToken),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const sessions = await executorA.query<SessionRow>(
      `SELECT s.revoked_at, s.revoke_reason, u.session_version
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.user_id = $1`,
      [userId]
    );
    expect(sessions.rows[0]?.revoke_reason).toBe('refresh_token_reuse');
  });

  it('replaying a rotated refresh token revokes the token family and all sessions', async () => {
    const email = `replay-${++userIndex}@example.test`;
    await serviceA.signup({ email, password: PASSWORD, displayName: 'Replay Owner' });
    const first = await serviceA.login({ identifier: email, password: PASSWORD });
    const second = await serviceA.login({ identifier: email, password: PASSWORD });
    const oldRefresh = first.tokens.refreshToken;
    const rotated = await serviceA.refresh(oldRefresh);

    // The legitimate rotation works and the old tokens are dead.
    await expect(serviceA.validateSession(first.tokens.sessionToken)).rejects.toThrow();
    expect(rotated.refreshToken).not.toBe(oldRefresh);

    // Replay is detected by the OTHER API instance.
    await expect(serviceB.refresh(oldRefresh)).rejects.toThrow();

    const sessions = await executorA.query<SessionRow>(
      `SELECT s.revoked_at, s.revoke_reason, u.session_version
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.user_id = $1`,
      [first.user.id]
    );
    expect(sessions.rows).toHaveLength(2);
    // The replayed token's family is explicitly revoked; the session_version
    // bump additionally invalidates EVERY session of that user.
    expect(sessions.rows.some((row) => row.revoke_reason === 'refresh_token_reuse')).toBe(true);
    expect(sessions.rows.every((row) => row.session_version === 1)).toBe(true);
    await expect(serviceA.validateSession(second.tokens.sessionToken)).rejects.toThrow();
    await expect(serviceA.validateSession(rotated.sessionToken)).rejects.toThrow();
    await expect(serviceA.refresh(rotated.refreshToken)).rejects.toThrow();
  });
});
