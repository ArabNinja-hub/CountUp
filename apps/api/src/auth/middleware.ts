import { parse } from 'cookie';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuthContext, AuthService } from './auth-service';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from './constants';
import { isDoubleSubmitValid } from './csrf';
import { authErrors } from './errors';
import { hashIdentifier, normaliseIp } from './tokens';
import type { SecurityOptions } from './security';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isUnsafe(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
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

/**
 * Strict Origin + Sec-Fetch-Site checks for every unsafe method. Requests with no
 * Origin AND no Sec-Fetch-Site are rejected (no silent bypass for legacy clients).
 */
export function originGuard(options: SecurityOptions): RequestHandler {
  return (req, _res, next) => {
    if (!isUnsafe(req.method)) {
      next();
      return;
    }
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    try {
      if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
        throw authErrors.crossOrigin();
      }
      if (typeof origin === 'string') {
        const selfOrigin = `${req.protocol}://${req.get('host') ?? ''}`;
        if (origin !== selfOrigin && !options.allowedOrigins.includes(origin)) {
          throw authErrors.crossOrigin();
        }
      } else if (site === undefined) {
        throw authErrors.crossOrigin();
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

export function loginRateLimit(options: SecurityOptions): RequestHandler {
  return (req, _res, next) => {
    const ip = normaliseIp(req.ip) ?? 'unknown';
    const identifier =
      typeof req.body === 'object' &&
      req.body !== null &&
      typeof (req.body as { identifier?: unknown }).identifier === 'string'
        ? hashIdentifier((req.body as { identifier: string }).identifier)
        : 'unknown';
    const allowed =
      options.limiter.allow(`global:${ip}`, options.rules.globalIp) &&
      options.limiter.allow(`login-ip:${ip}`, options.rules.loginIp) &&
      options.limiter.allow(`login-id:${identifier}`, options.rules.loginIdentity);
    next(allowed ? undefined : authErrors.rateLimited());
  };
}

export function recoveryRateLimit(options: SecurityOptions): RequestHandler {
  return (req, _res, next) => {
    const ip = normaliseIp(req.ip) ?? 'unknown';
    const allowed = options.limiter.allow(`recovery:${ip}`, options.rules.recoveryIp);
    next(allowed ? undefined : authErrors.rateLimited());
  };
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
