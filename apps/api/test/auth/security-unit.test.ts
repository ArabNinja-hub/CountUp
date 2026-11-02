import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import { EnvironmentError, loadEnv } from '../../src/config/env';
import type { SessionTokens } from '../../src/auth/auth-service';
import {
  CSRF_COOKIE,
  DEV_CSRF_SECRET,
  DEV_PEPPER,
  REFRESH_COOKIE,
  SESSION_COOKIE,
} from '../../src/auth/constants';
import { setSessionCookies, clearSessionCookies, setCsrfCookie } from '../../src/auth/cookies';
import { createCsrfToken, isDoubleSubmitValid, isValidCsrfSignature } from '../../src/auth/csrf';
import { PasswordHasher } from '../../src/auth/password';
import { createSecurityOptions } from '../../src/auth/security';
import {
  generateOpaqueToken,
  hashToken,
  normaliseIp,
  constantTimeEqual,
} from '../../src/auth/tokens';

const TOKENS: SessionTokens = {
  sessionId: '00000000-0000-4000-8000-000000000000',
  sessionToken: 'session-token-placeholder',
  refreshToken: 'refresh-token-placeholder',
  idleExpiresAt: new Date('2030-01-01T00:00:00Z'),
  absoluteExpiresAt: new Date('2030-02-01T00:00:00Z'),
};

function fakeResponse(): { res: Response; cookies: string[] } {
  const cookies: string[] = [];
  const res = {
    append: (_name: string, value: string) => {
      cookies.push(value);
    },
  } as unknown as Response;
  return { res, cookies };
}

describe('opaque tokens', () => {
  it('generates 256-bit tokens and stores only SHA-256 digests', () => {
    const token = generateOpaqueToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(generateOpaqueToken()).not.toBe(token);
    expect(hashToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken(token)).not.toBe(token);
    expect(hashToken(token)).toBe(hashToken(token));
  });

  it('normalises loopback IPs and compares strings in constant time', () => {
    expect(normaliseIp('::1')).toBe('127.0.0.1');
    expect(normaliseIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normaliseIp(null)).toBeNull();
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('CSRF', () => {
  it('signs tokens and rejects tampering or missing double-submit', () => {
    const token = createCsrfToken(DEV_CSRF_SECRET);
    expect(isValidCsrfSignature(DEV_CSRF_SECRET, token)).toBe(true);
    expect(isValidCsrfSignature('other-secret', token)).toBe(false);
    expect(isValidCsrfSignature(DEV_CSRF_SECRET, `${token}tampered`)).toBe(false);
    expect(isDoubleSubmitValid(DEV_CSRF_SECRET, token, token)).toBe(true);
    expect(isDoubleSubmitValid(DEV_CSRF_SECRET, token, undefined)).toBe(false);
    expect(isDoubleSubmitValid(DEV_CSRF_SECRET, token, 'different')).toBe(false);
  });
});

describe('password hashing', () => {
  it('uses Argon2id with a unique salt and a server-side pepper', async () => {
    const hasher = new PasswordHasher(DEV_PEPPER);
    const first = await hasher.hashPassword('Str0ngPassw0rd!2026');
    const second = await hasher.hashPassword('Str0ngPassw0rd!2026');
    expect(first).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1/);
    expect(first).not.toBe(second);
    expect(await hasher.verifyPassword(first, 'Str0ngPassw0rd!2026')).toBe(true);
    expect(await hasher.verifyPassword(first, 'wrong')).toBe(false);
    expect(
      await new PasswordHasher('different-pepper').verifyPassword(first, 'Str0ngPassw0rd!2026')
    ).toBe(false);
  });
});

describe('cookies', () => {
  it('uses HttpOnly + Secure + SameSite=Lax in production', () => {
    const { res, cookies } = fakeResponse();
    setSessionCookies(res, TOKENS, { isProduction: true });
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain(`${SESSION_COOKIE}=`);
    expect(cookies[1]).toContain(`${REFRESH_COOKIE}=`);
    for (const line of cookies) {
      expect(line).toContain('HttpOnly');
      expect(line).toContain('Secure');
      expect(line).toContain('SameSite=Lax');
    }
    expect(cookies[1]).toContain('Path=/auth/refresh');
  });

  it('omits Secure in local development, and clears cookies with Max-Age=0', () => {
    const set = fakeResponse();
    setSessionCookies(set.res, TOKENS, { isProduction: false });
    for (const line of set.cookies) {
      expect(line).toContain('HttpOnly');
      expect(line).not.toContain('; Secure');
    }
    const cleared = fakeResponse();
    clearSessionCookies(cleared.res, { isProduction: false });
    expect(cleared.cookies).toHaveLength(2);
    for (const line of cleared.cookies) {
      expect(line).toContain('Max-Age=0');
    }
    const csrf = fakeResponse();
    setCsrfCookie(csrf.res, 'csrf-value', { isProduction: false });
    expect(csrf.cookies[0]).toContain(`${CSRF_COOKIE}=csrf-value`);
    expect(csrf.cookies[0]).not.toContain('HttpOnly');
  });
});

describe('environment secrets', () => {
  it('refuses production without strong env secrets', () => {
    expect(() => loadEnv({ NODE_ENV: 'production' })).not.toThrow();
    expect(() => createSecurityOptions(loadEnv({ NODE_ENV: 'production' }))).toThrow(
      EnvironmentError
    );
    const pepper = 'a'.repeat(40);
    const csrfSecret = 'b'.repeat(40);
    const options = createSecurityOptions(
      loadEnv({ NODE_ENV: 'production', AUTH_PEPPER: pepper, CSRF_SECRET: csrfSecret })
    );
    expect(options.isProduction).toBe(true);
    expect(options.pepper).toBe(pepper);
    expect(options.csrfSecret).toBe(csrfSecret);
    expect(options.allowedOrigins).toEqual([]);
  });

  it('uses clearly labelled dev fallbacks outside production', () => {
    const options = createSecurityOptions(loadEnv({ NODE_ENV: 'test' }));
    expect(options.isProduction).toBe(false);
    expect(options.pepper).toBe(DEV_PEPPER);
    expect(options.csrfSecret).toBe(DEV_CSRF_SECRET);
    expect(options.rules.loginIp.max).toBeGreaterThan(0);
  });
});
