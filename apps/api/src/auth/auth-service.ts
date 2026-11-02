import type { QueryExecutor, QueryResultRow } from '../db/query-executor';
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
import { assertPlatformAdmin } from './roles';
import {
  generateOpaqueToken,
  hashIdentifier,
  hashToken,
  normaliseEmail,
  normaliseIp,
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
  idle_expires_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
  user_id: string;
  status: string;
  role: string;
  user_session_version: number;
}

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

  async login(input: LoginInput): Promise<{ tokens: SessionTokens; user: AuthenticatedUser }> {
    const identifier = input.identifier.includes('@')
      ? normaliseEmail(input.identifier)
      : normalisePhone(input.identifier);
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
      await writeSecurityAudit(this.executor, {
        action: 'auth.login.failed',
        actorIp: ip,
        targetType: 'identity',
        payload: { identifier_hash: identifierHash, reason: 'unknown_identifier' },
      });
      throw authErrors.invalidCredentials();
    }

    if (row.locked_until !== null && row.locked_until.getTime() > Date.now()) {
      throw authErrors.accountLocked();
    }
    if (row.status !== 'active') {
      throw new AuthError('account_inactive', 403, 'Account is not active');
    }

    const passwordOk = await this.hasher.verifyPassword(row.password_hash, input.password);
    if (!passwordOk) {
      const lockUntil = msFromNow(this.config.lockoutMs);
      const updated = await this.executor.query<{ failed_attempts: number }>(
        `UPDATE credentials
            SET failed_attempts = failed_attempts + 1,
                locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN $3::timestamptz ELSE NULL END
          WHERE user_id = $1
          RETURNING failed_attempts`,
        [row.user_id, this.config.lockoutThreshold, lockUntil]
      );
      const failures = updated.rows[0]?.failed_attempts ?? 0;
      await writeSecurityAudit(this.executor, {
        action: 'auth.login.failed',
        actorUserId: row.user_id,
        actorRole: row.role,
        actorIp: ip,
        targetType: 'users',
        targetId: row.user_id,
        payload: { identifier_hash: identifierHash, failed_attempts: failures },
      });
      throw failures >= this.config.lockoutThreshold
        ? authErrors.accountLocked()
        : authErrors.invalidCredentials();
    }

    await this.executor.query(
      'UPDATE credentials SET failed_attempts = 0, locked_until = NULL WHERE user_id = $1',
      [row.user_id]
    );

    const tokens = await this.createSession(
      row.user_id,
      row.user_session_version,
      ip,
      input.userAgent ?? null
    );
    await writeSecurityAudit(this.executor, {
      action: 'auth.login.succeeded',
      actorUserId: row.user_id,
      actorRole: row.role,
      actorIp: ip,
      targetType: 'sessions',
      targetId: tokens.sessionId,
      payload: { mechanism: 'password' },
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
    userId: string,
    sessionVersion: number,
    ip: string | null,
    userAgent: string | null
  ): Promise<SessionTokens> {
    const sessionToken = generateOpaqueToken();
    const refreshToken = generateOpaqueToken();
    const absoluteExpiresAt = msFromNow(this.config.sessionAbsoluteMs);
    const idleExpiresAt = msFromNow(this.config.sessionIdleMs);
    const inserted = await this.executor.query<{
      id: string;
      absolute_expires_at: Date;
      idle_expires_at: Date;
    }>(
      `INSERT INTO sessions
         (user_id, session_token_hash, refresh_token_hash, device_label, ip, user_agent,
          last_seen_at, absolute_expires_at, idle_expires_at, session_version, last_ip)
       VALUES ($1, $2, $3, $4, $5::inet, $6, now(), $7::timestamptz, $8::timestamptz, $9, $10::inet)
       RETURNING id, absolute_expires_at, idle_expires_at`,
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

  /** Rotates BOTH tokens; the old hashes are overwritten, so old tokens are dead. */
  async refresh(refreshToken: string): Promise<SessionTokens> {
    const found = await this.executor.query<RefreshRow>(
      `SELECT s.id AS session_id, s.session_version, s.idle_expires_at, s.absolute_expires_at,
              s.revoked_at, u.id AS user_id, u.status::text AS status,
              u.role::text AS role, u.session_version AS user_session_version
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.refresh_token_hash = $1`,
      [hashToken(refreshToken)]
    );
    const row = found.rows[0];
    const now = Date.now();
    if (
      row === undefined ||
      row.revoked_at !== null ||
      row.status !== 'active' ||
      row.session_version !== row.user_session_version ||
      row.idle_expires_at.getTime() <= now ||
      row.absolute_expires_at.getTime() <= now
    ) {
      throw authErrors.unauthenticated();
    }
    const sessionToken = generateOpaqueToken();
    const nextRefreshToken = generateOpaqueToken();
    const idleExpiresAt = msFromNow(this.config.sessionIdleMs);
    const updated = await this.executor.query<{ absolute_expires_at: Date }>(
      `UPDATE sessions
          SET session_token_hash = $2,
              refresh_token_hash = $3,
              last_seen_at = now(),
              idle_expires_at = LEAST($4::timestamptz, absolute_expires_at),
              rotated_at = now()
        WHERE id = $1
        RETURNING absolute_expires_at`,
      [row.session_id, hashToken(sessionToken), hashToken(nextRefreshToken), idleExpiresAt]
    );
    const absoluteExpiresAt = updated.rows[0]?.absolute_expires_at;
    if (absoluteExpiresAt === undefined) {
      throw authErrors.unauthenticated();
    }
    await writeSecurityAudit(this.executor, {
      action: 'auth.session.refreshed',
      actorUserId: row.user_id,
      actorRole: row.role,
      targetType: 'sessions',
      targetId: row.session_id,
      payload: { rotation: true },
    });
    return {
      sessionId: row.session_id,
      sessionToken,
      refreshToken: nextRefreshToken,
      absoluteExpiresAt,
      idleExpiresAt,
    };
  }

  async logout(sessionId: string, userId: string): Promise<void> {
    await this.executor.query(
      `UPDATE sessions SET revoked_at = now(), revoke_reason = 'logout'
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [sessionId, userId]
    );
    await writeSecurityAudit(this.executor, {
      action: 'auth.logout',
      actorUserId: userId,
      targetType: 'sessions',
      targetId: sessionId,
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
    const normalised = identifier.includes('@')
      ? normaliseEmail(identifier)
      : normalisePhone(identifier);
    const found = await this.executor.query<{ user_id: string }>(
      `SELECT i.user_id FROM auth_identities i WHERE i.identifier = $1 LIMIT 1`,
      [normalised]
    );
    await writeSecurityAudit(this.executor, {
      action: 'auth.password_recovery.requested',
      actorIp: ip,
      targetType: 'identity',
      targetId: found.rows[0]?.user_id ?? null,
      payload: { identifier_hash: hashIdentifier(normalised) },
    });
  }

  /** Controlled, audited operator handoff. Returns the raw token exactly once. */
  async adminIssueResetToken(
    actorUserId: string,
    targetUserId: string,
    evidence: Record<string, unknown>,
    ip: string | null
  ): Promise<string> {
    const actor = await assertPlatformAdmin(this.executor, actorUserId);
    const target = await this.executor.query<{ id: string }>('SELECT id FROM users WHERE id = $1', [
      targetUserId,
    ]);
    if (target.rows[0] === undefined) {
      throw authErrors.forbidden();
    }
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
        payload: { evidence },
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
    const { rows } = await this.executor.query<{ id: string }>(
      `UPDATE sessions SET revoked_at = now(), revoke_reason = 'user_revocation'
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
      [sessionId, userId]
    );
    if (rows[0] !== undefined) {
      await writeSecurityAudit(this.executor, {
        action: 'auth.session.revoked',
        actorUserId: userId,
        targetType: 'sessions',
        targetId: sessionId,
      });
    }
    return rows[0] !== undefined;
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
