import type { QueryExecutor, QueryResultRow } from '../db/query-executor';
import { parseAuditEvidence } from './audit-evidence';
import { writeSecurityAudit } from './audit';
import {
  LOCKOUT_MS,
  LOCKOUT_THRESHOLD,
  PASSWORD_ALGO,
  RESET_TOKEN_TTL_MS,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
} from './constants';
import { authErrors, AuthError } from './errors';
import type { IdentityVerifier, VerificationDecision } from './identity-verifier';
import { PasswordHasher, assertPasswordPolicy } from './password';
import { assertAdminTargetAllowed } from './roles';
import {
  generateOpaqueToken,
  hashIdentifier,
  hashToken,
  normaliseEmail,
  normaliseIp,
  normaliseLoginIdentifier,
  normalisePhone,
} from './tokens';

export interface AuthServiceConfig {
  sessionIdleMs: number;
  sessionAbsoluteMs: number;
  resetTokenTtlMs: number;
  lockoutThreshold: number;
  lockoutMs: number;
}

export const DEFAULT_AUTH_CONFIG: AuthServiceConfig = {
  sessionIdleMs: SESSION_IDLE_MS,
  sessionAbsoluteMs: SESSION_ABSOLUTE_MS,
  resetTokenTtlMs: RESET_TOKEN_TTL_MS,
  lockoutThreshold: LOCKOUT_THRESHOLD,
  lockoutMs: LOCKOUT_MS,
};

export interface AuthServiceOptions {
  executor: QueryExecutor;
  passwordHasher: PasswordHasher;
  verifier: IdentityVerifier;
  config?: Partial<AuthServiceConfig>;
}

export interface AuthenticatedUser {
  id: string;
  displayName: string | null;
  role: string;
  status: string;
  identityStatus: string;
  primaryEmail: string | null;
  primaryPhone: string | null;
  sessionVersion: number;
}

export interface AuthContext {
  user: AuthenticatedUser;
  sessionId: string;
  sessionTokenHash: string;
}

export interface SessionTokens {
  sessionId: string;
  sessionToken: string;
  refreshToken: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

export interface SignupInput {
  email: string;
  password: string;
  displayName: string;
  phone?: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface LoginInput {
  identifier: string;
  password: string;
  ip?: string | null;
  userAgent?: string | null;
}

interface UserCredentialRow extends QueryResultRow {
  user_id: string;
  display_name: string | null;
  role: string;
  status: string;
  identity_status: string;
  primary_email: string | null;
  primary_phone: string | null;
  user_session_version: number;
  password_hash: string;
  failed_attempts: number;
  locked_until: Date | null;
}

interface SessionRow extends QueryResultRow {
  session_id: string;
  session_token_hash: string;
  session_version: number;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  user_id: string;
  display_name: string | null;
  role: string;
  status: string;
  identity_status: string;
  primary_email: string | null;
  primary_phone: string | null;
  user_session_version: number;
}

interface RefreshRow extends QueryResultRow {
  session_id: string;
  session_version: number;
  token_family_id: string;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
  user_id: string;
  status: string;
  role: string;
  user_session_version: number;
}

interface RefreshHistoryRow extends QueryResultRow {
  token_hash: string;
  session_id: string;
  user_id: string;
  token_family_id: string;
  consumed_at: Date | null;
}

interface RotatedRow extends QueryResultRow {
  absolute_expires_at: Date;
  idle_expires_at: Date;
  token_family_id: string;
}

type RefreshOutcome = { reuse: true } | { reuse: false; tokens: SessionTokens };

function msFromNow(ms: number): Date {
  return new Date(Date.now() + ms);
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown }).code === '23505';
}

/** All authentication business logic lives here. Route handlers only parse + map. */
export class AuthService {
  readonly executor: QueryExecutor;
  readonly config: AuthServiceConfig;
  private readonly hasher: PasswordHasher;
  private readonly verifier: IdentityVerifier;

  constructor(options: AuthServiceOptions) {
    this.executor = options.executor;
    this.hasher = options.passwordHasher;
    this.verifier = options.verifier;
    this.config = { ...DEFAULT_AUTH_CONFIG, ...options.config };
  }

  get verificationMechanism(): string {
    return this.verifier.kind;
  }

  async signup(input: SignupInput): Promise<{ userId: string; identityStatus: string }> {
    assertPasswordPolicy(input.password);
    const email = normaliseEmail(input.email);
    const phone = input.phone === undefined ? null : normalisePhone(input.phone);
    const ip = normaliseIp(input.ip);
    const passwordHash = await this.hasher.hashPassword(input.password);

    try {
      return await this.executor.transaction(async (tx) => {
        const created = await tx.query<{ id: string }>(
          `INSERT INTO users
             (primary_email, primary_phone, display_name, role, status, identity_status)
           VALUES ($1, $2, $3, 'owner', 'active', 'unverified') RETURNING id`,
          [email, phone, input.displayName]
        );
        const userId = created.rows[0]?.id;
        if (userId === undefined) {
          throw new Error('user insert returned no id');
        }
        await tx.query(
          `INSERT INTO auth_identities (user_id, kind, identifier, is_primary, verified_at)
           VALUES ($1, 'email', $2, true, NULL)`,
          [userId, email]
        );
        if (phone !== null) {
          await tx.query(
            `INSERT INTO auth_identities (user_id, kind, identifier, is_primary, verified_at)
             VALUES ($1, 'phone', $2, false, NULL)`,
            [userId, phone]
          );
        }
        await tx.query(
          'INSERT INTO credentials (user_id, password_hash, password_algo) VALUES ($1, $2, $3)',
          [userId, passwordHash, PASSWORD_ALGO]
        );
        await this.verifier.recordRequest(tx, userId, ip);
        await writeSecurityAudit(tx, {
          action: 'auth.signup',
          actorUserId: userId,
          actorRole: 'owner',
          actorIp: ip,
          targetType: 'users',
          targetId: userId,
          payload: { mechanism: this.verifier.kind, identity_status: 'unverified' },
        });
        return { userId, identityStatus: 'unverified' };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw authErrors.duplicateIdentity();
      }
      throw error;
    }
  }

  /**
   * C-10: every credential/session state change and its audit event are one
   * transaction. `normaliseLoginIdentifier` is also used by the limiter (C-03).
   */
  async login(input: LoginInput): Promise<{ tokens: SessionTokens; user: AuthenticatedUser }> {
    const identifier = normaliseLoginIdentifier(input.identifier);
    const ip = normaliseIp(input.ip);
    const identifierHash = hashIdentifier(identifier);

    const found = await this.executor.query<UserCredentialRow>(
      `SELECT u.id AS user_id, u.display_name, u.role::text AS role, u.status::text AS status,
              u.identity_status::text AS identity_status, u.primary_email, u.primary_phone,
              u.session_version AS user_session_version,
              c.password_hash, c.failed_attempts, c.locked_until
         FROM users u
         JOIN auth_identities i ON i.user_id = u.id
         JOIN credentials c ON c.user_id = u.id
        WHERE i.identifier = $1
        LIMIT 1`,
      [identifier]
    );
    const row = found.rows[0];
    if (row === undefined) {
      await this.hasher.dummyVerify(input.password);
      await this.executor.transaction((tx) =>
        writeSecurityAudit(tx, {
          action: 'auth.login.failed',
          actorIp: ip,
          targetType: 'identity',
          payload: { identifier_hash: identifierHash, reason: 'unknown_identifier' },
        })
      );
      throw authErrors.invalidCredentials();
    }

    if (row.locked_until !== null && row.locked_until.getTime() > Date.now()) {
      await this.executor.transaction((tx) =>
        writeSecurityAudit(tx, {
          action: 'auth.login.locked',
          actorUserId: row.user_id,
          actorRole: row.role,
          actorIp: ip,
          targetType: 'users',
          targetId: row.user_id,
          payload: { reason: 'account_locked' },
        })
      );
      throw authErrors.accountLocked();
    }
    if (row.status !== 'active') {
      await this.executor.transaction((tx) =>
        writeSecurityAudit(tx, {
          action: 'auth.login.inactive',
          actorUserId: row.user_id,
          actorRole: row.role,
          actorIp: ip,
          targetType: 'users',
          targetId: row.user_id,
          payload: { reason: 'account_inactive' },
        })
      );
      throw new AuthError('account_inactive', 403, 'Account is not active');
    }

    const passwordOk = await this.hasher.verifyPassword(row.password_hash, input.password);
    if (!passwordOk) {
      const lockUntil = msFromNow(this.config.lockoutMs);
      const failures = await this.executor.transaction(async (tx) => {
        const updated = await tx.query<{ failed_attempts: number }>(
          `UPDATE credentials
              SET failed_attempts = failed_attempts + 1,
                  locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN $3::timestamptz ELSE NULL END
            WHERE user_id = $1
            RETURNING failed_attempts`,
          [row.user_id, this.config.lockoutThreshold, lockUntil]
        );
        const count = updated.rows[0]?.failed_attempts ?? 0;
        await writeSecurityAudit(tx, {
          action: 'auth.login.failed',
          actorUserId: row.user_id,
          actorRole: row.role,
          actorIp: ip,
          targetType: 'users',
          targetId: row.user_id,
          payload: { identifier_hash: identifierHash, failed_attempts: count },
        });
        return count;
      });
      throw failures >= this.config.lockoutThreshold
        ? authErrors.accountLocked()
        : authErrors.invalidCredentials();
    }

    const tokens = await this.executor.transaction(async (tx) => {
      await tx.query(
        'UPDATE credentials SET failed_attempts = 0, locked_until = NULL WHERE user_id = $1',
        [row.user_id]
      );
      const created = await this.createSession(
        tx,
        row.user_id,
        row.user_session_version,
        ip,
        input.userAgent ?? null
      );
      await writeSecurityAudit(tx, {
        action: 'auth.login.succeeded',
        actorUserId: row.user_id,
        actorRole: row.role,
        actorIp: ip,
        targetType: 'sessions',
        targetId: created.sessionId,
        payload: { mechanism: 'password' },
      });
      return created;
    });
    return { tokens, user: this.toAuthenticatedUser(row) };
  }

  private toAuthenticatedUser(row: UserCredentialRow): AuthenticatedUser {
    return {
      id: row.user_id,
      displayName: row.display_name,
      role: row.role,
      status: row.status,
      identityStatus: row.identity_status,
      primaryEmail: row.primary_email,
      primaryPhone: row.primary_phone,
      sessionVersion: row.user_session_version,
    };
  }

  private async createSession(
    executor: QueryExecutor,
    userId: string,
    sessionVersion: number,
    ip: string | null,
    userAgent: string | null
  ): Promise<SessionTokens> {
    const sessionToken = generateOpaqueToken();
    const refreshToken = generateOpaqueToken();
    const absoluteExpiresAt = msFromNow(this.config.sessionAbsoluteMs);
    const idleExpiresAt = msFromNow(this.config.sessionIdleMs);
    const inserted = await executor.query<{
      id: string;
      token_family_id: string;
      absolute_expires_at: Date;
      idle_expires_at: Date;
    }>(
      `INSERT INTO sessions
         (user_id, session_token_hash, refresh_token_hash, device_label, ip, user_agent,
          last_seen_at, absolute_expires_at, idle_expires_at, session_version, last_ip,
          token_family_id)
       VALUES ($1, $2, $3, $4, $5::inet, $6, now(), $7::timestamptz, $8::timestamptz, $9,
               $10::inet, gen_random_uuid())
       RETURNING id, token_family_id, absolute_expires_at, idle_expires_at`,
      [
        userId,
        hashToken(sessionToken),
        hashToken(refreshToken),
        'pilot-web',
        ip,
        userAgent,
        absoluteExpiresAt,
        idleExpiresAt,
        sessionVersion,
        ip,
      ]
    );
    const row = inserted.rows[0];
    if (row === undefined) {
      throw new Error('session insert returned no id');
    }
    // C-01: every issued refresh hash is recorded so a consumed one is recognised
    // as reuse even after the session row has been rotated.
    await executor.query(
      `INSERT INTO refresh_token_history (token_hash, session_id, user_id, token_family_id)
       VALUES ($1, $2, $3, $4)`,
      [hashToken(refreshToken), row.id, userId, row.token_family_id]
    );
    return {
      sessionId: row.id,
      sessionToken,
      refreshToken,
      absoluteExpiresAt: row.absolute_expires_at,
      idleExpiresAt: row.idle_expires_at,
    };
  }

  /** Validates an opaque token and slides idle expiry (never past absolute expiry). */
  async validateSession(token: string, ip: string | null = null): Promise<AuthContext> {
    const found = await this.executor.query<SessionRow>(
      `SELECT s.id AS session_id, s.session_token_hash, s.session_version,
              s.idle_expires_at, s.absolute_expires_at,
              u.id AS user_id, u.display_name, u.role::text AS role,
              u.status::text AS status, u.identity_status::text AS identity_status,
              u.primary_email, u.primary_phone,
              u.session_version AS user_session_version
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.session_token_hash = $1 AND s.revoked_at IS NULL`,
      [hashToken(token)]
    );
    const row = found.rows[0];
    const now = Date.now();
    if (
      row === undefined ||
      row.status !== 'active' ||
      row.session_version !== row.user_session_version ||
      row.idle_expires_at.getTime() <= now ||
      row.absolute_expires_at.getTime() <= now
    ) {
      throw authErrors.unauthenticated();
    }
    await this.executor.query(
      `UPDATE sessions
          SET last_seen_at = now(),
              idle_expires_at = LEAST($2::timestamptz, absolute_expires_at),
              last_ip = $3::inet
        WHERE id = $1`,
      [row.session_id, msFromNow(this.config.sessionIdleMs), normaliseIp(ip)]
    );
    return {
      sessionId: row.session_id,
      sessionTokenHash: row.session_token_hash,
      user: {
        id: row.user_id,
        displayName: row.display_name,
        role: row.role,
        status: row.status,
        identityStatus: row.identity_status,
        primaryEmail: row.primary_email,
        primaryPhone: row.primary_phone,
        sessionVersion: row.user_session_version,
      },
    };
  }

  /**
   * C-01: atomic compare-and-swap rotation.
   *
   * `UPDATE ... WHERE refresh_token_hash = $old ... RETURNING` is a single atomic
   * statement. Two concurrent callers race on the same row: the loser's UPDATE
   * re-evaluates its WHERE after the winner commits and returns zero rows. The
   * loser then re-reads `refresh_token_history` and sees the consumed hash —
   * proof of reuse — so the whole token family is revoked, the user's
   * session_version is bumped and an alert is written, ALL in the same
   * transaction, before the request is rejected.
   */
  async refresh(refreshToken: string, ip: string | null = null): Promise<SessionTokens> {
    const oldHash = hashToken(refreshToken);
    const sessionToken = generateOpaqueToken();
    const nextRefreshToken = generateOpaqueToken();
    const newSessionHash = hashToken(sessionToken);
    const newRefreshHash = hashToken(nextRefreshToken);
    const idleExpiresAt = msFromNow(this.config.sessionIdleMs);

    const outcome: RefreshOutcome = await this.executor.transaction(async (tx) => {
      const history = await tx.query<RefreshHistoryRow>(
        `SELECT token_hash, session_id, user_id, token_family_id, consumed_at
           FROM refresh_token_history WHERE token_hash = $1`,
        [oldHash]
      );
      const prior = history.rows[0];
      if (prior !== undefined && prior.consumed_at !== null) {
        return this.revokeFamilyForReuse(tx, prior, oldHash, ip);
      }

      const found = await tx.query<RefreshRow>(
        `SELECT s.id AS session_id, s.session_version, s.token_family_id,
                s.idle_expires_at, s.absolute_expires_at, s.revoked_at,
                u.id AS user_id, u.status::text AS status,
                u.role::text AS role, u.session_version AS user_session_version
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.refresh_token_hash = $1`,
        [oldHash]
      );
      const row = found.rows[0];
      if (row !== undefined) {
        const now = Date.now();
        const valid =
          row.revoked_at === null &&
          row.status === 'active' &&
          row.session_version === row.user_session_version &&
          row.idle_expires_at.getTime() > now &&
          row.absolute_expires_at.getTime() > now;
        if (valid) {
          const updated = await tx.query<RotatedRow>(
            `UPDATE sessions
                SET session_token_hash = $2,
                    refresh_token_hash = $3,
                    last_seen_at = now(),
                    idle_expires_at = LEAST($4::timestamptz, absolute_expires_at),
                    last_ip = $7::inet,
                    rotated_at = now()
              WHERE id = $1
                AND refresh_token_hash = $5
                AND revoked_at IS NULL
                AND session_version = $6
                AND idle_expires_at > now()
                AND absolute_expires_at > now()
              RETURNING absolute_expires_at, idle_expires_at, token_family_id`,
            [
              row.session_id,
              newSessionHash,
              newRefreshHash,
              idleExpiresAt,
              oldHash,
              row.session_version,
              ip,
            ]
          );
          const rotated = updated.rows[0];
          if (rotated !== undefined) {
            await tx.query(
              `UPDATE refresh_token_history SET consumed_at = now()
                WHERE token_hash = $1 AND consumed_at IS NULL`,
              [oldHash]
            );
            await tx.query(
              `INSERT INTO refresh_token_history (token_hash, session_id, user_id, token_family_id)
               VALUES ($1, $2, $3, $4)`,
              [newRefreshHash, row.session_id, row.user_id, rotated.token_family_id]
            );
            await writeSecurityAudit(tx, {
              action: 'auth.session.refreshed',
              actorUserId: row.user_id,
              actorRole: row.role,
              actorIp: ip,
              targetType: 'sessions',
              targetId: row.session_id,
              payload: { rotation: true },
            });
            return {
              reuse: false,
              tokens: {
                sessionId: row.session_id,
                sessionToken,
                refreshToken: nextRefreshToken,
                absoluteExpiresAt: rotated.absolute_expires_at,
                idleExpiresAt: rotated.idle_expires_at,
              },
            };
          }
        }
      }

      // No live row (or the CAS lost a race). Re-read with a fresh READ COMMITTED
      // snapshot: a concurrent winner has now committed the consumed history row.
      const recheck = await tx.query<RefreshHistoryRow>(
        `SELECT token_hash, session_id, user_id, token_family_id, consumed_at
           FROM refresh_token_history WHERE token_hash = $1`,
        [oldHash]
      );
      const consumed = recheck.rows[0];
      if (consumed !== undefined && consumed.consumed_at !== null) {
        return this.revokeFamilyForReuse(tx, consumed, oldHash, ip);
      }
      throw authErrors.unauthenticated();
    });

    if (outcome.reuse) {
      throw authErrors.unauthenticated();
    }
    return outcome.tokens;
  }

  private async revokeFamilyForReuse(
    tx: QueryExecutor,
    history: RefreshHistoryRow,
    oldHash: string,
    ip: string | null
  ): Promise<RefreshOutcome> {
    await tx.query(
      'UPDATE refresh_token_history SET reuse_detected_at = now() WHERE token_hash = $1',
      [oldHash]
    );
    await tx.query(
      `UPDATE sessions SET revoked_at = now(), revoke_reason = 'refresh_token_reuse'
        WHERE token_family_id = $1 AND revoked_at IS NULL`,
      [history.token_family_id]
    );
    await tx.query('UPDATE users SET session_version = session_version + 1 WHERE id = $1', [
      history.user_id,
    ]);
    await writeSecurityAudit(tx, {
      action: 'auth.session.refresh_reuse_detected',
      actorUserId: history.user_id,
      actorIp: ip,
      targetType: 'sessions',
      targetId: history.session_id,
      payload: { reuse_detected: true, session_family_revoked: true },
    });
    return { reuse: true };
  }

  async logout(sessionId: string, userId: string, ip: string | null = null): Promise<void> {
    await this.executor.transaction(async (tx) => {
      await tx.query(
        `UPDATE sessions SET revoked_at = now(), revoke_reason = 'logout'
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [sessionId, userId]
      );
      await writeSecurityAudit(tx, {
        action: 'auth.logout',
        actorUserId: userId,
        actorIp: ip,
        targetType: 'sessions',
        targetId: sessionId,
      });
    });
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    currentSessionId: string,
    ip: string | null
  ): Promise<void> {
    assertPasswordPolicy(newPassword);
    const found = await this.executor.query<{ password_hash: string }>(
      'SELECT password_hash FROM credentials WHERE user_id = $1',
      [userId]
    );
    const stored = found.rows[0]?.password_hash;
    if (stored === undefined || !(await this.hasher.verifyPassword(stored, currentPassword))) {
      throw authErrors.invalidCredentials();
    }
    const newHash = await this.hasher.hashPassword(newPassword);
    await this.executor.transaction(async (tx) => {
      await tx.query(
        'UPDATE credentials SET password_hash = $2, password_algo = $3, password_updated_at = now(), failed_attempts = 0, locked_until = NULL WHERE user_id = $1',
        [userId, newHash, PASSWORD_ALGO]
      );
      await tx.query(
        `UPDATE sessions SET revoked_at = now(), revoke_reason = 'password_change'
          WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
        [userId, currentSessionId]
      );
      await writeSecurityAudit(tx, {
        action: 'auth.password.changed',
        actorUserId: userId,
        actorIp: ip,
        targetType: 'users',
        targetId: userId,
      });
    });
  }

  /** Always returns normally — never reveals whether the account exists. */
  async requestPasswordRecovery(identifier: string, ip: string | null): Promise<void> {
    const normalised = normaliseLoginIdentifier(identifier);
    await this.executor.transaction(async (tx) => {
      const found = await tx.query<{ user_id: string }>(
        `SELECT i.user_id FROM auth_identities i WHERE i.identifier = $1 LIMIT 1`,
        [normalised]
      );
      await writeSecurityAudit(tx, {
        action: 'auth.password_recovery.requested',
        actorIp: ip,
        targetType: 'identity',
        targetId: found.rows[0]?.user_id ?? null,
        payload: { identifier_hash: hashIdentifier(normalised) },
      });
    });
  }

  /** Controlled, audited operator handoff. Returns the raw token exactly once. */
  async adminIssueResetToken(
    actorUserId: string,
    targetUserId: string,
    evidence: unknown,
    ip: string | null
  ): Promise<string> {
    // C-05: no self-reset and no admin-to-admin privileged reset over HTTP.
    const { actor } = await assertAdminTargetAllowed(this.executor, actorUserId, targetUserId);
    // C-09: strict allowlist, enforced for direct callers too.
    const safeEvidence = parseAuditEvidence(evidence);
    const token = generateOpaqueToken();
    await this.executor.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO password_reset_tokens
           (user_id, token_hash, expires_at, is_admin_initiated, initiated_by, requested_ip)
         VALUES ($1, $2, $3::timestamptz, true, $4, $5::inet)`,
        [targetUserId, hashToken(token), msFromNow(this.config.resetTokenTtlMs), actor.id, ip]
      );
      await writeSecurityAudit(tx, {
        action: 'auth.password_recovery.admin_token_issued',
        actorUserId: actor.id,
        actorRole: actor.role,
        actorIp: ip,
        targetType: 'users',
        targetId: targetUserId,
        payload: { evidence: safeEvidence },
      });
    });
    return token;
  }

  /** Single-use, time-limited reset; revokes EVERY session and bumps session_version. */
  async confirmPasswordReset(token: string, newPassword: string): Promise<void> {
    assertPasswordPolicy(newPassword);
    const tokenHash = hashToken(token);
    const newHash = await this.hasher.hashPassword(newPassword);
    await this.executor.transaction(async (tx) => {
      const consumed = await tx.query<{ user_id: string }>(
        `UPDATE password_reset_tokens SET used_at = now()
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
          RETURNING user_id`,
        [tokenHash]
      );
      const userId = consumed.rows[0]?.user_id;
      if (userId === undefined) {
        throw authErrors.invalidToken();
      }
      await tx.query(
        `UPDATE credentials
            SET password_hash = $2, password_algo = $3, password_updated_at = now(),
                failed_attempts = 0, locked_until = NULL
          WHERE user_id = $1`,
        [userId, newHash, PASSWORD_ALGO]
      );
      await tx.query(
        `UPDATE sessions SET revoked_at = now(), revoke_reason = 'password_reset'
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
      );
      await tx.query('UPDATE users SET session_version = session_version + 1 WHERE id = $1', [
        userId,
      ]);
      await writeSecurityAudit(tx, {
        action: 'auth.password_recovery.completed',
        actorUserId: userId,
        targetType: 'users',
        targetId: userId,
        payload: { all_sessions_revoked: true },
      });
    });
  }

  async listSessions(userId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await this.executor.query<Record<string, unknown>>(
      `SELECT id, device_label, created_at, last_seen_at, idle_expires_at,
              absolute_expires_at, revoked_at, rotated_at
         FROM sessions WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    // Deliberately no session_token_hash / refresh_token_hash columns.
    return rows;
  }

  async revokeSession(userId: string, sessionId: string): Promise<boolean> {
    return this.executor.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `UPDATE sessions SET revoked_at = now(), revoke_reason = 'user_revocation'
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
        [sessionId, userId]
      );
      if (rows[0] !== undefined) {
        await writeSecurityAudit(tx, {
          action: 'auth.session.revoked',
          actorUserId: userId,
          targetType: 'sessions',
          targetId: sessionId,
        });
      }
      return rows[0] !== undefined;
    });
  }

  /** Session-version invalidation (ADR-01): all existing tokens stop working. */
  async invalidateAllSessions(userId: string): Promise<void> {
    await this.executor.transaction(async (tx) => {
      await tx.query('UPDATE users SET session_version = session_version + 1 WHERE id = $1', [
        userId,
      ]);
      await tx.query(
        `UPDATE sessions SET revoked_at = now(), revoke_reason = 'session_version_invalidation'
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
      );
      await writeSecurityAudit(tx, {
        action: 'auth.sessions.invalidated',
        actorUserId: userId,
        targetType: 'users',
        targetId: userId,
      });
    });
  }

  async getUser(userId: string): Promise<AuthenticatedUser | null> {
    const { rows } = await this.executor.query<{
      id: string;
      display_name: string | null;
      role: string;
      status: string;
      identity_status: string;
      primary_email: string | null;
      primary_phone: string | null;
      session_version: number;
    }>(
      `SELECT id, display_name, role::text AS role, status::text AS status,
              identity_status::text AS identity_status, primary_email, primary_phone,
              session_version
         FROM users WHERE id = $1`,
      [userId]
    );
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      id: row.id,
      displayName: row.display_name,
      role: row.role,
      status: row.status,
      identityStatus: row.identity_status,
      primaryEmail: row.primary_email,
      primaryPhone: row.primary_phone,
      sessionVersion: row.session_version,
    };
  }

  async verifyIdentity(
    decision: VerificationDecision
  ): Promise<{ status: string; verificationId: string }> {
    return this.verifier.decide(this.executor, decision);
  }
}
