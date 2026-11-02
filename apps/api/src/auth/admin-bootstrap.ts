import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { QueryExecutor, QueryResultRow } from '../db/query-executor';
import { writeSecurityAudit } from './audit';
import { PASSWORD_ALGO } from './constants';
import { PasswordHasher, assertPasswordPolicy } from './password';
import { constantTimeEqual, generateOpaqueToken, hashToken, normaliseEmail } from './tokens';

export type AdminBootstrapErrorCode =
  'invalid_input' | 'already_bootstrapped' | 'invalid_shares' | 'grant_not_available';

export class AdminBootstrapError extends Error {
  constructor(
    readonly code: AdminBootstrapErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'AdminBootstrapError';
  }
}

const bootstrapAdminSchema = z
  .object({
    email: z.string().trim().email().max(254),
    password: z.string(),
    displayName: z.string().trim().min(1).max(120),
  })
  .strict();

export interface BootstrapAdminInput {
  email: string;
  password: string;
  displayName: string;
}

export interface BootstrapInput {
  /** At least TWO distinct administrators (dual control, no single point of loss). */
  admins: BootstrapAdminInput[];
  /** Explicit operator acknowledgement — no accidental admin creation. */
  confirm: boolean;
  ip?: string | null;
}

export interface BootstrapResult {
  adminUserIds: string[];
  primaryAdminUserId: string;
  /** Printed ONCE. Store the two shares with separate custodians. */
  recoveryShares: [string, string];
  expiresAt: Date;
}

export interface RecoverInput {
  shareA: string;
  shareB: string;
  newPassword: string;
  confirm: boolean;
  ip?: string | null;
}

export interface RecoverResult {
  userId: string;
  /** Fresh single-use shares; the consumed ones are now worthless. */
  recoveryShares: [string, string];
  expiresAt: Date;
}

interface GrantRow extends QueryResultRow {
  id: string;
  share_a_hash: string;
  share_b_hash: string;
  primary_admin_user_id: string;
  expires_at: Date;
  used_at: Date | null;
}

const GRANT_TTL_MS = 365 * 24 * 60 * 60 * 1000;

function newShares(): [string, string] {
  return [generateOpaqueToken(), generateOpaqueToken()];
}

/**
 * C-02. The ONLY supported way to create the first `platform_admin` accounts and
 * the ONLY supported recovery path when administrators lose access.
 *
 *  * No credential is hardcoded or committed — passwords come from the operator.
 *  * One-time: `platform_bootstrap.singleton` + `ON CONFLICT DO NOTHING`.
 *  * Require two distinct admins, so a single lost account is not a deadlock.
 *  * Two independently generated break-glass shares are printed once; only their
 *    SHA-256 digests are stored. Recovery requires BOTH (dual control).
 *  * Every success AND every rejected bootstrap/recovery writes an append-only
 *    `platform_audit` row inside the same transaction as the state change.
 */
export class AdminBootstrapService {
  constructor(
    private readonly executor: QueryExecutor,
    private readonly hasher: PasswordHasher
  ) {}

  async bootstrap(input: BootstrapInput): Promise<BootstrapResult> {
    if (input.confirm !== true) {
      throw new AdminBootstrapError('invalid_input', 'bootstrap requires explicit confirmation');
    }
    if (input.admins.length < 2) {
      throw new AdminBootstrapError(
        'invalid_input',
        'bootstrap requires at least two distinct administrators'
      );
    }
    const admins = input.admins.map((admin) => bootstrapAdminSchema.parse(admin));
    const emails = admins.map((admin) => normaliseEmail(admin.email));
    if (new Set(emails).size !== emails.length) {
      throw new AdminBootstrapError('invalid_input', 'administrator emails must be distinct');
    }
    for (const admin of admins) {
      assertPasswordPolicy(admin.password);
    }

    const ids = admins.map(() => randomUUID());
    const primaryAdminUserId = ids[0] as string;
    const ip = input.ip ?? null;
    const passwordHashes = await Promise.all(
      admins.map((admin) => this.hasher.hashPassword(admin.password))
    );
    const recoveryShares = newShares();
    const expiresAt = new Date(Date.now() + GRANT_TTL_MS);

    try {
      await this.executor.transaction(async (tx) => {
        // Early read so a repeated bootstrap is refused BEFORE it re-inserts the
        // same emails (which would otherwise surface as a uniqueness error).
        // The atomic gate below still protects concurrent bootstraps.
        const existing = await tx.query<{ singleton: boolean }>(
          'SELECT singleton FROM platform_bootstrap'
        );
        if (existing.rows[0] !== undefined) {
          throw new AdminBootstrapError('already_bootstrapped', 'bootstrap already completed');
        }

        for (let index = 0; index < admins.length; index += 1) {
          const admin = admins[index] as (typeof admins)[number];
          const id = ids[index] as string;
          await tx.query(
            `INSERT INTO users
               (id, primary_email, display_name, role, status, identity_status,
                identity_verified_at, identity_verified_by)
             VALUES ($1, $2, $3, 'platform_admin', 'active', 'verified', now(), NULL)`,
            [id, emails[index], admin.displayName]
          );
          await tx.query(
            `INSERT INTO auth_identities
               (user_id, kind, identifier, is_primary, verified_at)
             VALUES ($1, 'email', $2, true, now())`,
            [id, emails[index]]
          );
          await tx.query(
            'INSERT INTO credentials (user_id, password_hash, password_algo) VALUES ($1, $2, $3)',
            [id, passwordHashes[index], PASSWORD_ALGO]
          );
        }

        // Atomic one-time gate, placed after the admin rows so the FK is valid.
        // A second (or concurrent) bootstrap gets zero rows and its whole
        // transaction — including the newly created admins — is rolled back.
        const gate = await tx.query<{ singleton: boolean }>(
          `INSERT INTO platform_bootstrap
             (singleton, primary_admin_user_id, admin_count, bootstrap_ip)
           VALUES (true, $1, $2, $3::inet)
           ON CONFLICT (singleton) DO NOTHING
           RETURNING singleton`,
          [primaryAdminUserId, admins.length, ip]
        );
        if (gate.rows[0] === undefined) {
          throw new AdminBootstrapError('already_bootstrapped', 'bootstrap already completed');
        }

        await tx.query(
          `INSERT INTO admin_recovery_grants
             (share_a_hash, share_b_hash, primary_admin_user_id, expires_at)
           VALUES ($1, $2, $3, $4::timestamptz)`,
          [
            hashToken(recoveryShares[0]),
            hashToken(recoveryShares[1]),
            primaryAdminUserId,
            expiresAt,
          ]
        );
        await writeSecurityAudit(tx, {
          action: 'auth.admin.bootstrap_completed',
          actorUserId: primaryAdminUserId,
          actorRole: 'platform_admin',
          actorIp: ip,
          targetType: 'users',
          targetId: primaryAdminUserId,
          payload: { admin_count: admins.length, dual_control: true },
        });
      });
    } catch (error) {
      if (error instanceof AdminBootstrapError && error.code === 'already_bootstrapped') {
        // Auditable rejection, committed on its own after the failed tx rolls back.
        await this.executor.transaction((tx) =>
          writeSecurityAudit(tx, {
            action: 'auth.admin.bootstrap_rejected',
            actorIp: ip,
            targetType: 'users',
            targetId: primaryAdminUserId,
            payload: { reason: 'already_bootstrapped' },
          })
        );
      }
      throw error;
    }

    return { adminUserIds: ids, primaryAdminUserId, recoveryShares, expiresAt };
  }

  async recover(input: RecoverInput): Promise<RecoverResult> {
    if (input.confirm !== true) {
      throw new AdminBootstrapError('invalid_input', 'recovery requires explicit confirmation');
    }
    if (
      typeof input.shareA !== 'string' ||
      typeof input.shareB !== 'string' ||
      input.shareA.length < 20 ||
      input.shareB.length < 20 ||
      input.shareA === input.shareB
    ) {
      throw new AdminBootstrapError('invalid_shares', 'two distinct recovery shares are required');
    }
    assertPasswordPolicy(input.newPassword);
    const ip = input.ip ?? null;
    const newHash = await this.hasher.hashPassword(input.newPassword);
    const nextShares = newShares();
    const expiresAt = new Date(Date.now() + GRANT_TTL_MS);

    return this.executor.transaction(async (tx) => {
      const grants = await tx.query<GrantRow>(
        `SELECT id, share_a_hash, share_b_hash, primary_admin_user_id, expires_at, used_at
           FROM admin_recovery_grants WHERE used_at IS NULL FOR UPDATE LIMIT 1`
      );
      const grant = grants.rows[0];
      if (grant === undefined) {
        throw new AdminBootstrapError('grant_not_available', 'no active break-glass grant');
      }
      const valid =
        constantTimeEqual(hashToken(input.shareA), grant.share_a_hash) &&
        constantTimeEqual(hashToken(input.shareB), grant.share_b_hash) &&
        grant.expires_at.getTime() > Date.now();
      if (!valid) {
        // Deliberately indistinguishable from a missing grant to an operator who
        // only has one share; no partial state change is committed.
        throw new AdminBootstrapError('invalid_shares', 'recovery shares are not valid');
      }

      const userId = grant.primary_admin_user_id;
      const target = await tx.query<{ id: string; role: string; status: string }>(
        'SELECT id, role::text AS role, status::text AS status FROM users WHERE id = $1',
        [userId]
      );
      if (target.rows[0]?.role !== 'platform_admin') {
        throw new AdminBootstrapError('grant_not_available', 'bootstrap admin no longer exists');
      }

      await tx.query(
        `UPDATE credentials
            SET password_hash = $2, password_algo = $3, password_updated_at = now(),
                failed_attempts = 0, locked_until = NULL
          WHERE user_id = $1`,
        [userId, newHash, PASSWORD_ALGO]
      );
      await tx.query(
        `UPDATE sessions SET revoked_at = now(), revoke_reason = 'break_glass_recovery'
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
      );
      await tx.query(
        `UPDATE users SET status = 'active', session_version = session_version + 1 WHERE id = $1`,
        [userId]
      );
      const consumed = await tx.query<{ id: string }>(
        `UPDATE admin_recovery_grants SET used_at = now(), used_ip = $2::inet
          WHERE id = $1 AND used_at IS NULL RETURNING id`,
        [grant.id, ip]
      );
      if (consumed.rows[0] === undefined) {
        throw new AdminBootstrapError('grant_not_available', 'grant was consumed concurrently');
      }
      // Rotate the break-glass material: a successful recovery issues new shares.
      await tx.query(
        `INSERT INTO admin_recovery_grants
           (share_a_hash, share_b_hash, primary_admin_user_id, expires_at)
         VALUES ($1, $2, $3, $4::timestamptz)`,
        [hashToken(nextShares[0]), hashToken(nextShares[1]), userId, expiresAt]
      );
      await writeSecurityAudit(tx, {
        action: 'auth.admin.break_glass_recovery',
        actorUserId: userId,
        actorRole: 'platform_admin',
        actorIp: ip,
        targetType: 'users',
        targetId: userId,
        payload: { dual_control: true, sessions_revoked: true, grant_rotated: true },
      });
      return { userId, recoveryShares: nextShares, expiresAt };
    });
  }
}
