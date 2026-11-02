import { readFileSync } from 'node:fs';
import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import { EnvironmentError, loadEnv } from '../../src/config/env';
import type { SessionTokens } from '../../src/auth/auth-service';
import { CSRF_COOKIE, REFRESH_COOKIE, SESSION_COOKIE } from '../../src/auth/constants';
import { setSessionCookies, clearSessionCookies, setCsrfCookie } from '../../src/auth/cookies';
import { createCsrfToken, isDoubleSubmitValid, isValidCsrfSignature } from '../../src/auth/csrf';
import { PasswordHasher } from '../../src/auth/password';
import { createSecurityOptions } from '../../src/auth/security';
import {
  generateOpaqueToken,
  hashToken,
  normaliseIp,
  normaliseLoginIdentifier,
  constantTimeEqual,
} from '../../src/auth/tokens';
import { TEST_AUTH_PEPPER, TEST_CSRF_SECRET, testEnv } from '../test-env';

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

  it('normalises loopback IPs, identifiers and compares strings in constant time', () => {
    expect(normaliseIp('::1')).toBe('127.0.0.1');
    expect(normaliseIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normaliseIp(null)).toBeNull();
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(normaliseLoginIdentifier('  Case@Test.Test  ')).toBe('case@test.test');
    expect(normaliseLoginIdentifier('+260 (97) 123-4567')).toBe('+260971234567');
  });
});

describe('CSRF', () => {
  it('signs tokens and rejects tampering or missing double-submit', () => {
    const token = createCsrfToken(TEST_CSRF_SECRET);
    expect(isValidCsrfSignature(TEST_CSRF_SECRET, token)).toBe(true);
    expect(isValidCsrfSignature('other-secret', token)).toBe(false);
    expect(isValidCsrfSignature(TEST_CSRF_SECRET, `${token}tampered`)).toBe(false);
    expect(isDoubleSubmitValid(TEST_CSRF_SECRET, token, token)).toBe(true);
    expect(isDoubleSubmitValid(TEST_CSRF_SECRET, token, undefined)).toBe(false);
    expect(isDoubleSubmitValid(TEST_CSRF_SECRET, token, 'different')).toBe(false);
  });
});

describe('password hashing', () => {
  it('uses Argon2id with a unique salt and a server-side pepper', async () => {
    const hasher = new PasswordHasher(TEST_AUTH_PEPPER);
    const first = await hasher.hashPassword('Str0ngPassw0rd!2026');
    const second = await hasher.hashPassword('Str0ngPassw0rd!2026');
    expect(first).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1/);
    expect(first).not.toBe(second);
    expect(await hasher.verifyPassword(first, 'Str0ngPassw0rd!2026')).toBe(true);
    expect(await hasher.verifyPassword(first, 'wrong')).toBe(false);
    expect(
      await new PasswordHasher('a-completely-different-pepper').verifyPassword(
        first,
        'Str0ngPassw0rd!2026'
      )
    ).toBe(false);
  });
});

describe('cookies (C-04 explicit secure behaviour)', () => {
  it('uses HttpOnly + Secure + SameSite=Lax when HTTPS is configured', () => {
    const { res, cookies } = fakeResponse();
    setSessionCookies(res, TOKENS, { secure: true });
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

  it('omits Secure only when explicitly configured for plain HTTP', () => {
    const set = fakeResponse();
    setSessionCookies(set.res, TOKENS, { secure: false });
    for (const line of set.cookies) {
      expect(line).toContain('HttpOnly');
      expect(line).not.toContain('; Secure');
    }
    const cleared = fakeResponse();
    clearSessionCookies(cleared.res, { secure: false });
    expect(cleared.cookies).toHaveLength(2);
    for (const line of cleared.cookies) {
      expect(line).toContain('Max-Age=0');
    }
    const csrf = fakeResponse();
    setCsrfCookie(csrf.res, 'csrf-value', { secure: false });
    expect(csrf.cookies[0]).toContain(`${CSRF_COOKIE}=csrf-value`);
    expect(csrf.cookies[0]).not.toContain('HttpOnly');
  });
});

describe('C-04 environment secrets — fail closed in EVERY NODE_ENV', () => {
  const valid = {
    AUTH_PEPPER: TEST_AUTH_PEPPER,
    CSRF_SECRET: TEST_CSRF_SECRET,
  };

  it('no longer ships any development fallback secret', () => {
    for (const file of ['src/auth/constants.ts', 'src/auth/security.ts', 'src/config/env.ts']) {
      const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/DEV_PEPPER|DEV_CSRF_SECRET|NOT_A_SECRET|__COUNTUP_DEV_ONLY/);
    }
  });

  it('accepts strong, distinct secrets in test/development (no NODE_ENV escape hatch)', () => {
    const options = createSecurityOptions(testEnv());
    expect(options.isProduction).toBe(false);
    expect(options.pepper).toBe(TEST_AUTH_PEPPER);
    expect(options.csrfSecret).toBe(TEST_CSRF_SECRET);
    expect(options.limiter).toBeDefined();
    expect(options.rules.signupIp.max).toBeGreaterThan(0);
  });

  it.each([
    ['missing AUTH_PEPPER', { CSRF_SECRET: TEST_CSRF_SECRET }],
    ['missing CSRF_SECRET', { AUTH_PEPPER: TEST_AUTH_PEPPER }],
    ['missing both', {}],
    ['short secret', { AUTH_PEPPER: 'short', CSRF_SECRET: TEST_CSRF_SECRET }],
    [
      'placeholder secret',
      { AUTH_PEPPER: 'development-pepper-value-1234567890', CSRF_SECRET: TEST_CSRF_SECRET },
    ],
    [
      'low-entropy secret',
      { AUTH_PEPPER: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', CSRF_SECRET: TEST_CSRF_SECRET },
    ],
    ['identical secrets', { AUTH_PEPPER: TEST_AUTH_PEPPER, CSRF_SECRET: TEST_AUTH_PEPPER }],
  ])('refuses to start: %s', (_label, secrets) => {
    expect(() => createSecurityOptions(loadEnv({ NODE_ENV: 'test', ...secrets }))).toThrow(
      EnvironmentError
    );
  });

  it('requires an exact HTTPS origin allowlist in production', () => {
    expect(() => createSecurityOptions(loadEnv({ NODE_ENV: 'production', ...valid }))).toThrow(
      /PUBLIC_APP_ORIGIN/
    );
    const options = createSecurityOptions(
      loadEnv({
        NODE_ENV: 'production',
        ...valid,
        PUBLIC_APP_ORIGIN: 'https://app.example.com',
      })
    );
    expect(options.allowedOrigins).toEqual(['https://app.example.com']);
    expect(options.secureCookies).toBe(true);
  });

  it.each([
    'not-a-url',
    'https://app.example.com/path',
    'http://app.example.com',
    'https://user:pass@app.example.com',
    'https://app.example.com:443',
    'ftp://app.example.com',
  ])('rejects unsafe PUBLIC_APP_ORIGIN: %s', (origin) => {
    expect(() =>
      createSecurityOptions(
        loadEnv({ NODE_ENV: 'production', ...valid, PUBLIC_APP_ORIGIN: origin })
      )
    ).toThrow(EnvironmentError);
  });

  it('derives Secure cookies from explicit HTTPS configuration, not NODE_ENV alone', () => {
    const httpsDev = createSecurityOptions(
      loadEnv({
        NODE_ENV: 'development',
        ...valid,
        PUBLIC_APP_ORIGIN: 'https://staging.example.com',
      })
    );
    expect(httpsDev.secureCookies).toBe(true);
    const forced = createSecurityOptions(
      loadEnv({ NODE_ENV: 'development', ...valid, COOKIE_SECURE: 'true' })
    );
    expect(forced.secureCookies).toBe(true);
    const plain = createSecurityOptions(
      loadEnv({ NODE_ENV: 'development', ...valid, COOKIE_SECURE: 'false' })
    );
    expect(plain.secureCookies).toBe(false);
    expect(() =>
      createSecurityOptions(
        loadEnv({
          NODE_ENV: 'production',
          ...valid,
          PUBLIC_APP_ORIGIN: 'https://app.example.com',
          COOKIE_SECURE: 'false',
        })
      )
    ).toThrow(/COOKIE_SECURE=false/);
  });
});
