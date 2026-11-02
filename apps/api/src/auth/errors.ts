export type AuthErrorCode =
  | 'validation_error'
  | 'invalid_credentials'
  | 'account_locked'
  | 'account_inactive'
  | 'duplicate_identity'
  | 'unauthenticated'
  | 'forbidden'
  | 'owner_only'
  | 'unverified_identity'
  | 'invalid_csrf'
  | 'cross_origin'
  | 'rate_limited'
  | 'invalid_token'
  | 'admin_self_action'
  | 'admin_tier_protected'
  | 'database_unavailable'
  | 'internal_error';

/** One consistent error envelope for every auth / security failure. */
export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    readonly status: number,
    message: string,
    readonly details?: string[]
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export const authErrors = {
  invalidCredentials: () =>
    new AuthError('invalid_credentials', 401, 'Invalid identifier or password'),
  accountLocked: () => new AuthError('account_locked', 429, 'Too many failed attempts'),
  duplicateIdentity: () => new AuthError('duplicate_identity', 409, 'Identity already registered'),
  unauthenticated: () => new AuthError('unauthenticated', 401, 'Authentication required'),
  forbidden: () => new AuthError('forbidden', 403, 'Not authorised'),
  ownerOnly: () => new AuthError('owner_only', 403, 'Owner-only access'),
  unverified: () => new AuthError('unverified_identity', 403, 'Identity verification required'),
  invalidCsrf: () => new AuthError('invalid_csrf', 403, 'CSRF validation failed'),
  crossOrigin: () => new AuthError('cross_origin', 403, 'Cross-origin request rejected'),
  rateLimited: () => new AuthError('rate_limited', 429, 'Too many requests'),
  invalidToken: () => new AuthError('invalid_token', 400, 'Invalid or expired token'),
  adminSelfAction: () =>
    new AuthError('admin_self_action', 403, 'Administrators may not target themselves'),
  adminTierProtected: () =>
    new AuthError(
      'admin_tier_protected',
      403,
      'Administrator-tier accounts require break-glass recovery'
    ),
  databaseUnavailable: () => new AuthError('database_unavailable', 503, 'Database not configured'),
} as const;
