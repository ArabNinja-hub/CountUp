import { EnvironmentError, type AppEnv } from '../config/env';
import {
  DEFAULT_RATE_RULES,
  InMemoryRateLimiter,
  type RateLimiter,
  type RateLimitRules,
} from './rate-limit';
import { resolveSecrets } from './secrets';

export type SecurityRules = RateLimitRules;

export interface SecurityOptions {
  isProduction: boolean;
  pepper: string;
  csrfSecret: string;
  /** Exact origins, validated at startup. Never derived from the Host header. */
  allowedOrigins: string[];
  secureCookies: boolean;
  /** null = forwarded headers are NOT trusted. */
  trustProxyHops: number | null;
  limiter: RateLimiter;
  rules: SecurityRules;
}

export interface SecurityOverrides {
  limiter?: RateLimiter;
  rules?: Partial<SecurityRules>;
  allowedOrigins?: string[];
  pepper?: string;
  csrfSecret?: string;
  secureCookies?: boolean;
}

/** Strict absolute-origin parser. Rejects paths, credentials, wildcards and default ports. */
export function normaliseTrustedOrigin(raw: string, isProduction: boolean): string {
  if (raw.length === 0 || raw.trim() !== raw || /\s/.test(raw)) {
    throw new EnvironmentError(`PUBLIC_APP_ORIGIN entry is not an exact origin: "${raw}"`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EnvironmentError(`PUBLIC_APP_ORIGIN entry is not an absolute URL: "${raw}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EnvironmentError(`PUBLIC_APP_ORIGIN must use http/https: "${raw}"`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new EnvironmentError(`PUBLIC_APP_ORIGIN must not contain credentials: "${raw}"`);
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new EnvironmentError(`PUBLIC_APP_ORIGIN must be an origin without a path: "${raw}"`);
  }
  if (url.origin !== raw) {
    throw new EnvironmentError(`PUBLIC_APP_ORIGIN must be a canonical origin: "${raw}"`);
  }
  if (isProduction && url.protocol !== 'https:') {
    throw new EnvironmentError(`PUBLIC_APP_ORIGIN must be HTTPS in production: "${raw}"`);
  }
  return url.origin;
}

export function createSecurityOptions(
  env: AppEnv,
  overrides: SecurityOverrides = {}
): SecurityOptions {
  const isProduction = env.NODE_ENV === 'production';

  // C-04: fail closed in EVERY environment. No NODE_ENV conditional, no fallback.
  const { pepper, csrfSecret } = resolveSecrets(env, overrides);

  const rawOrigins =
    env.PUBLIC_APP_ORIGIN === undefined
      ? []
      : env.PUBLIC_APP_ORIGIN.split(',')
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0);
  // Keep an injected array object intact so tests can register a dynamically bound
  // port after the server starts. Values are validated in place.
  const allowedOrigins = overrides.allowedOrigins ?? [];
  if (overrides.allowedOrigins === undefined) {
    for (const origin of rawOrigins) {
      allowedOrigins.push(normaliseTrustedOrigin(origin, isProduction));
    }
  } else {
    for (let index = 0; index < allowedOrigins.length; index += 1) {
      allowedOrigins[index] = normaliseTrustedOrigin(allowedOrigins[index] ?? '', isProduction);
    }
  }
  if (isProduction && allowedOrigins.length === 0) {
    throw new EnvironmentError(
      'PUBLIC_APP_ORIGIN is required in production; exact HTTPS origins only'
    );
  }

  let secureCookies: boolean;
  if (overrides.secureCookies !== undefined) {
    secureCookies = overrides.secureCookies;
  } else if (env.COOKIE_SECURE === 'true') {
    secureCookies = true;
  } else if (env.COOKIE_SECURE === 'false') {
    if (isProduction) {
      throw new EnvironmentError('COOKIE_SECURE=false is not permitted in production');
    }
    secureCookies = false;
  } else {
    secureCookies = isProduction || allowedOrigins.some((origin) => origin.startsWith('https://'));
  }

  return {
    isProduction,
    pepper,
    csrfSecret,
    allowedOrigins,
    secureCookies,
    trustProxyHops: env.TRUST_PROXY_HOPS ?? null,
    // `createApp` injects a PostgresRateLimiter when a DB executor is available.
    limiter: overrides.limiter ?? new InMemoryRateLimiter(),
    rules: { ...DEFAULT_RATE_RULES, ...overrides.rules },
  };
}
