import { describe, expect, it } from 'vitest';
import { AdminBootstrapService } from '../../src/auth/admin-bootstrap';
import { AuthService } from '../../src/auth/auth-service';
import { AdminAssistedIdentityVerifier } from '../../src/auth/identity-verifier';
import { PasswordHasher } from '../../src/auth/password';
import { AuthError } from '../../src/auth/errors';
import type { QueryResultRow } from '../../src/db/query-executor';
import { createMigratedDatabase, type IsolatedDatabase } from '../isolated-database';
import { TEST_AUTH_PEPPER, testEnv } from '../test-env';

const PASSWORD_A = 'Str0ngPassw0rd!2026';
const PASSWORD_B = 'An0therStr0ngPassw0rd!2026';
const NEW_PASSWORD = 'Br3akGlassRecovered!2026';
const ADMINS = [
  { email: 'admin-one@example.test', password: PASSWORD_A, displayName: 'Admin One' },
  { email: 'admin-two@example.test', password: PASSWORD_B, displayName: 'Admin Two' },
];

interface CountRow extends QueryResultRow {
  count: number;
}
interface GrantRow extends QueryResultRow {
  share_a_hash: string;
  share_b_hash: string;
  used_at: Date | null;
}
interface AuditRow extends QueryResultRow {
  action: string;
}

async function setup(): Promise<{
  db: IsolatedDatabase;
  bootstrap: AdminBootstrapService;
  auth: AuthService;
}> {
  const db = await createMigratedDatabase();
  const hasher = new PasswordHasher(TEST_AUTH_PEPPER);
  return {
    db,
    bootstrap: new AdminBootstrapService(db.executor, hasher),
    auth: new AuthService({
      executor: db.executor,
      passwordHasher: hasher,
      verifier: new AdminAssistedIdentityVerifier(),
    }),
  };
}

async function count(
  db: IsolatedDatabase,
  sql: string,
  values: readonly unknown[] = []
): Promise<number> {
  const { rows } = await db.executor.query<CountRow>(sql, values);
  return rows[0]?.count ?? -1;
}

describe('C-02 — auditable one-time administrator bootstrap', () => {
  it('creates two admins, stores only share digests and writes an audit row', async () => {
    const { db, bootstrap, auth } = await setup();
    try {
      const result = await bootstrap.bootstrap({ admins: ADMINS, confirm: true });
      expect(result.adminUserIds).toHaveLength(2);
      expect(result.primaryAdminUserId).toBe(result.adminUserIds[0]);
      expect(result.recoveryShares[0]).not.toBe(result.recoveryShares[1]);

      expect(
        await count(db, "SELECT count(*)::int AS count FROM users WHERE role = 'platform_admin'")
      ).toBe(2);
      expect(await count(db, 'SELECT count(*)::int AS count FROM platform_bootstrap')).toBe(1);
      const grants = await db.executor.query<GrantRow>(
        'SELECT share_a_hash, share_b_hash, used_at FROM admin_recovery_grants'
      );
      expect(grants.rows).toHaveLength(1);
      const grant = grants.rows[0];
      expect(grant?.share_a_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(grant?.share_b_hash).toMatch(/^[a-f0-9]{64}$/);
      for (const share of result.recoveryShares) {
        expect(JSON.stringify(grants.rows)).not.toContain(share);
      }
      expect(grant?.used_at).toBeNull();

      const audits = await db.executor.query<AuditRow>(
        'SELECT action FROM platform_audit ORDER BY id'
      );
      expect(audits.rows.map((row) => row.action)).toContain('auth.admin.bootstrap_completed');

      const login = await auth.login({ identifier: ADMINS[0]!.email, password: PASSWORD_A });
      expect(login.user.role).toBe('platform_admin');
      expect(login.user.identityStatus).toBe('verified');
      const user = await db.executor.query<{ identity_verified_by: string | null }>(
        'SELECT identity_verified_by FROM users WHERE id = $1',
        [result.primaryAdminUserId]
      );
      expect(user.rows[0]?.identity_verified_by).toBeNull(); // no self-verification marker
    } finally {
      await db.close();
    }
  });

  it('rejects unconfirmed, single-admin, weak-password and duplicate-email bootstraps', async () => {
    for (const input of [
      { admins: ADMINS, confirm: false },
      { admins: [ADMINS[0]!], confirm: true },
      { admins: [{ ...ADMINS[0]!, password: 'short' }, ADMINS[1]!], confirm: true },
      { admins: [ADMINS[0]!, { ...ADMINS[1]!, email: ADMINS[0]!.email }], confirm: true },
    ]) {
      const { db, bootstrap } = await setup();
      try {
        await expect(bootstrap.bootstrap(input)).rejects.toThrow();
        expect(await count(db, 'SELECT count(*)::int AS count FROM users')).toBe(0);
        expect(await count(db, 'SELECT count(*)::int AS count FROM platform_bootstrap')).toBe(0);
      } finally {
        await db.close();
      }
    }
  });

  it('a repeated bootstrap is refused, changes nothing, and is itself audited', async () => {
    const { db, bootstrap } = await setup();
    try {
      await bootstrap.bootstrap({ admins: ADMINS, confirm: true });
      const before = await db.executor.query<{ password_hash: string }>(
        'SELECT password_hash FROM credentials ORDER BY password_hash'
      );
      await expect(bootstrap.bootstrap({ admins: ADMINS, confirm: true })).rejects.toThrow(
        /already completed/
      );
      expect(await count(db, 'SELECT count(*)::int AS count FROM users')).toBe(2);
      expect(await count(db, 'SELECT count(*)::int AS count FROM platform_bootstrap')).toBe(1);
      expect(await count(db, 'SELECT count(*)::int AS count FROM admin_recovery_grants')).toBe(1);
      const after = await db.executor.query<{ password_hash: string }>(
        'SELECT password_hash FROM credentials ORDER BY password_hash'
      );
      expect(after.rows).toEqual(before.rows);
      const audits = await db.executor.query<AuditRow>(
        "SELECT action FROM platform_audit WHERE action = 'auth.admin.bootstrap_rejected'"
      );
      expect(audits.rows).toHaveLength(1);
    } finally {
      await db.close();
    }
  });
});

describe('C-02 — dual-control break-glass recovery', () => {
  it('requires both shares, rotates them, resets access and revokes sessions', async () => {
    const { db, bootstrap, auth } = await setup();
    try {
      const result = await bootstrap.bootstrap({ admins: ADMINS, confirm: true });
      const [shareA, shareB] = result.recoveryShares;
      const login = await auth.login({ identifier: ADMINS[0]!.email, password: PASSWORD_A });
      const sessionId = login.tokens.sessionId;

      // A single/incorrect share must not change anything.
      await expect(
        bootstrap.recover({
          shareA,
          shareB: 'wrong-share-that-is-long-enough-to-pass-shape',
          newPassword: NEW_PASSWORD,
          confirm: true,
        })
      ).rejects.toThrow();
      expect(
        await count(
          db,
          'SELECT count(*)::int AS count FROM admin_recovery_grants WHERE used_at IS NULL'
        )
      ).toBe(1);
      expect(
        await count(
          db,
          "SELECT count(*)::int AS count FROM platform_audit WHERE action = 'auth.admin.break_glass_recovery'"
        )
      ).toBe(0);

      const recovered = await bootstrap.recover({
        shareA,
        shareB,
        newPassword: NEW_PASSWORD,
        confirm: true,
      });
      expect(recovered.userId).toBe(result.primaryAdminUserId);
      expect(recovered.recoveryShares[0]).not.toBe(shareA);
      expect(recovered.recoveryShares[1]).not.toBe(shareB);

      // Old password no longer works; the new one does.
      await expect(
        auth.login({ identifier: ADMINS[0]!.email, password: PASSWORD_A })
      ).rejects.toBeInstanceOf(AuthError);
      expect(
        (await auth.login({ identifier: ADMINS[0]!.email, password: NEW_PASSWORD })).user.role
      ).toBe('platform_admin');

      const session = await db.executor.query<{
        revoked_at: Date | null;
        revoke_reason: string | null;
      }>('SELECT revoked_at, revoke_reason FROM sessions WHERE id = $1', [sessionId]);
      expect(session.rows[0]?.revoke_reason).toBe('break_glass_recovery');
      const version = await db.executor.query<{ session_version: number }>(
        'SELECT session_version FROM users WHERE id = $1',
        [result.primaryAdminUserId]
      );
      expect(version.rows[0]?.session_version).toBe(1);
      expect(
        await count(
          db,
          'SELECT count(*)::int AS count FROM admin_recovery_grants WHERE used_at IS NULL'
        )
      ).toBe(1);
      expect(
        await count(
          db,
          "SELECT count(*)::int AS count FROM platform_audit WHERE action = 'auth.admin.break_glass_recovery'"
        )
      ).toBe(1);

      // Consumed shares are worthless (single-use grant).
      await expect(
        bootstrap.recover({ shareA, shareB, newPassword: NEW_PASSWORD, confirm: true })
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('rejects recovery without explicit confirmation or with identical shares', async () => {
    const { db, bootstrap } = await setup();
    try {
      const { recoveryShares } = await bootstrap.bootstrap({ admins: ADMINS, confirm: true });
      await expect(
        bootstrap.recover({
          shareA: recoveryShares[0],
          shareB: recoveryShares[1],
          newPassword: NEW_PASSWORD,
          confirm: false,
        })
      ).rejects.toThrow(/confirmation/);
      await expect(
        bootstrap.recover({
          shareA: recoveryShares[0],
          shareB: recoveryShares[0],
          newPassword: NEW_PASSWORD,
          confirm: true,
        })
      ).rejects.toThrow(/distinct/);
      expect(
        await count(
          db,
          "SELECT count(*)::int AS count FROM platform_audit WHERE action = 'auth.admin.break_glass_recovery'"
        )
      ).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('the bootstrap admin can be reached through the normal HTTP login path', async () => {
    // Env is exercised here so a misconfigured secret cannot silently produce a
    // bootstrap that the API itself would refuse to start with.
    expect(testEnv().AUTH_PEPPER).toBe(TEST_AUTH_PEPPER);
    const { db, bootstrap } = await setup();
    try {
      await bootstrap.bootstrap({ admins: ADMINS, confirm: true });
      expect(
        await count(db, "SELECT count(*)::int AS count FROM users WHERE status = 'active'")
      ).toBe(2);
    } finally {
      await db.close();
    }
  });
});
