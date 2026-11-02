import { serialize, type CookieSerializeOptions } from 'cookie';
import type { Response } from 'express';
import { CSRF_COOKIE, REFRESH_COOKIE, SESSION_COOKIE } from './constants';
import type { SessionTokens } from './auth-service';

/**
 * C-04: `secure` is an explicit deployment decision, never a NODE_ENV guess.
 * It is true whenever the app is served over HTTPS (production, an HTTPS origin
 * allowlist, or COOKIE_SECURE=true).
 */
export interface CookiePolicy {
  secure: boolean;
}

function baseOptions(policy: CookiePolicy, path: string): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: policy.secure,
    sameSite: 'lax',
    path,
  };
}

export function setSessionCookies(
  res: Response,
  tokens: SessionTokens,
  policy: CookiePolicy
): void {
  res.append(
    'Set-Cookie',
    serialize(SESSION_COOKIE, tokens.sessionToken, {
      ...baseOptions(policy, '/'),
      expires: tokens.absoluteExpiresAt,
    })
  );
  res.append(
    'Set-Cookie',
    serialize(REFRESH_COOKIE, tokens.refreshToken, {
      ...baseOptions(policy, '/auth/refresh'),
      expires: tokens.absoluteExpiresAt,
    })
  );
}

export function clearSessionCookies(res: Response, policy: CookiePolicy): void {
  for (const [name, path] of [
    [SESSION_COOKIE, '/'],
    [REFRESH_COOKIE, '/auth/refresh'],
  ] as const) {
    res.append(
      'Set-Cookie',
      serialize(name, '', {
        ...baseOptions(policy, path),
        maxAge: 0,
        expires: new Date(0),
      })
    );
  }
}

/** The CSRF cookie is readable by frontend JS (double-submit pattern). */
export function setCsrfCookie(res: Response, token: string, policy: CookiePolicy): void {
  res.append(
    'Set-Cookie',
    serialize(CSRF_COOKIE, token, {
      httpOnly: false,
      secure: policy.secure,
      sameSite: 'lax',
      path: '/',
    })
  );
}
