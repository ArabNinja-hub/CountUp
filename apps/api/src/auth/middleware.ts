import { parse } from 'cookie';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuthContext, AuthService } from './auth-service';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from './constants';
import { isDoubleSubmitValid } from './csrf';
import { authErrors } from './errors';
import type { SecurityOptions } from './security';
import { hashIdentifier, normaliseEmail, normaliseIp, normaliseLoginIdentifier } from './tokens';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isUnsafe(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

function asyncMiddleware(
  work: (req: Request, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req, res, next) => {
    void work(req, res, next).catch(next);
  };
}

/** Never let a proxy or browser cache a private API response. */
export const noStore: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  next();
};

export function getAuthContext(res: Response): AuthContext | null {
  return (res.locals.auth as AuthContext | undefined) ?? null;
}

export function readSessionToken(req: Request): string | undefined {
  return parse(req.headers.cookie ?? '')[SESSION_COOKIE];
}

/** Strict absolute-origin parser for the `Origin` header. */
function parseRequestOrigin(value: string): string {
  if (value === 'null' || value.includes(',') || /\s/.test(value)) {
    throw authErrors.crossOrigin();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw authErrors.crossOrigin();
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw authErrors.crossOrigin();
  }
  if (url.username !== '' || url.password !== '') {
    throw authErrors.crossOrigin();
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw authErrors.crossOrigin();
  }
  if (url.origin !== value) {
    throw authErrors.crossOrigin();
  }
  return url.origin;
}

function isLoopback(req: Request): boolean {
  const address = req.socket.remoteAddress ?? '';
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('::ffff:127.0.0.1')
  );
}

/**
 * C-07. Every unsafe method MUST present an exact, well-formed `Origin` that is
 * in the validated allowlist. `Sec-Fetch-Site` is NEVER proof of origin: it is
 * only used to reject obviously cross-site evidence, and `none` gives no
 * exemption. In production the allowlist is mandatory and no Host-derived
 * self-origin fallback exists.
 */
export function originGuard(options: SecurityOptions): RequestHandler {
  return (req, _res, next) => {
    if (!isUnsafe(req.method)) {
      next();
      return;
    }
    try {
      const site = req.headers['sec-fetch-site'];
      if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
        throw authErrors.crossOrigin();
      }
      const raw = req.headers.origin;
      if (typeof raw !== 'string' || raw.length === 0) {
        throw authErrors.crossOrigin();
      }
      const origin = parseRequestOrigin(raw);
      if (!options.allowedOrigins.includes(origin)) {
        // Local, non-production, loopback-only convenience for the M0/M1 smoke
        // route. Never available in production, never when an allowlist is set,
        // and never for a non-loopback peer.
        if (
          options.isProduction ||
          options.allowedOrigins.length > 0 ||
          !isLoopback(req) ||
          parseRequestOrigin(`${req.protocol}://${req.get('host') ?? ''}`) !== origin
        ) {
          throw authErrors.crossOrigin();
        }
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Signed double-submit CSRF protection for all unsafe methods. */
export function csrfGuard(options: SecurityOptions): RequestHandler {
  return (req, _res, next) => {
    if (!isUnsafe(req.method)) {
      next();
      return;
    }
    const cookies = parse(req.headers.cookie ?? '');
    const header = req.get(CSRF_HEADER);
    if (!isDoubleSubmitValid(options.csrfSecret, cookies[CSRF_COOKIE], header)) {
      next(authErrors.invalidCsrf());
      return;
    }
    next();
  };
}

function clientIp(req: Request): string {
  return normaliseIp(req.ip) ?? 'unknown';
}

function bodyString(req: Request, field: string): string | undefined {
  const body = req.body;
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

/** C-03: the identifier is canonicalised with the SAME function used by login. */
function loginIdentityKey(req: Request): string {
  const raw = bodyString(req, 'identifier');
  return raw === undefined ? 'unknown' : hashIdentifier(normaliseLoginIdentifier(raw));
}

function signupIdentityKey(req: Request): string {
  const raw = bodyString(req, 'email');
  return raw === undefined ? 'unknown' : hashIdentifier(normaliseEmail(raw));
}

/** A shared per-IP budget applied to EVERY /auth/* route, including GETs. */
export function globalRateLimit(options: SecurityOptions): RequestHandler {
  return asyncMiddleware(async (req, _res, next) => {
    const allowed = await options.limiter.allow(`global:${clientIp(req)}`, options.rules.globalIp);
    next(allowed ? undefined : authErrors.rateLimited());
  });
}

export function loginRateLimit(options: SecurityOptions): RequestHandler {
  return asyncMiddleware(async (req, _res, next) => {
    const ip = clientIp(req);
    // No `&&` short-circuit: every bucket is accounted for, and all limits are
    // evaluated against the same shared PostgreSQL store.
    const results = await Promise.all([
      options.limiter.allow(`login-ip:${ip}`, options.rules.loginIp),
      options.limiter.allow(`login-id:${loginIdentityKey(req)}`, options.rules.loginIdentity),
    ]);
    next(results.every(Boolean) ? undefined : authErrors.rateLimited());
  });
}

export function signupRateLimit(options: SecurityOptions): RequestHandler {
  return asyncMiddleware(async (req, _res, next) => {
    const ip = clientIp(req);
    const results = await Promise.all([
      options.limiter.allow(`signup-ip:${ip}`, options.rules.signupIp),
      options.limiter.allow(`signup-id:${signupIdentityKey(req)}`, options.rules.signupIdentity),
    ]);
    next(results.every(Boolean) ? undefined : authErrors.rateLimited());
  });
}

export function recoveryRateLimit(options: SecurityOptions): RequestHandler {
  return asyncMiddleware(async (req, _res, next) => {
    const allowed = await options.limiter.allow(
      `recovery:${clientIp(req)}`,
      options.rules.recoveryIp
    );
    next(allowed ? undefined : authErrors.rateLimited());
  });
}

export function recoveryConfirmRateLimit(options: SecurityOptions): RequestHandler {
  return asyncMiddleware(async (req, _res, next) => {
    const allowed = await options.limiter.allow(
      `recovery-confirm:${clientIp(req)}`,
      options.rules.recoveryConfirmIp
    );
    next(allowed ? undefined : authErrors.rateLimited());
  });
}

export function refreshRateLimit(options: SecurityOptions): RequestHandler {
  return asyncMiddleware(async (req, _res, next) => {
    const allowed = await options.limiter.allow(
      `refresh:${clientIp(req)}`,
      options.rules.refreshIp
    );
    next(allowed ? undefined : authErrors.rateLimited());
  });
}

export function adminRateLimit(options: SecurityOptions): RequestHandler {
  return asyncMiddleware(async (req, _res, next) => {
    const allowed = await options.limiter.allow(`admin:${clientIp(req)}`, options.rules.adminIp);
    next(allowed ? undefined : authErrors.rateLimited());
  });
}

/** Validates the opaque session cookie against PostgreSQL on every protected request. */
export function requireAuth(service: AuthService): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const token = readSessionToken(req);
      if (token === undefined) {
        throw authErrors.unauthenticated();
      }
      const context = await service.validateSession(token, normaliseIp(req.ip));
      res.locals.auth = context;
      next();
    })().catch(next);
  };
}

export function requireOwner(): RequestHandler {
  return (_req, res, next) => {
    const context = getAuthContext(res);
    if (context === null) {
      next(authErrors.unauthenticated());
      return;
    }
    if (context.user.role !== 'owner') {
      next(authErrors.ownerOnly());
      return;
    }
    next();
  };
}

/** C-06: `users.identity_status` is the ONE authoritative verification state. */
export function requireVerified(): RequestHandler {
  return (_req, res, next) => {
    const context = getAuthContext(res);
    if (context === null) {
      next(authErrors.unauthenticated());
      return;
    }
    if (context.user.identityStatus !== 'verified') {
      next(authErrors.unverified());
      return;
    }
    next();
  };
}

export function requirePlatformAdmin(): RequestHandler {
  return (_req, res, next) => {
    const context = getAuthContext(res);
    if (context === null) {
      next(authErrors.unauthenticated());
      return;
    }
    if (context.user.role !== 'platform_admin') {
      next(authErrors.forbidden());
      return;
    }
    next();
  };
}
