import { EnvironmentError, type AppEnv } from '../config/env';
import { DEV_CSRF_SECRET, DEV_PEPPER } from './constants';
import { DEFAULT_RATE_RULES, RateLimiter, type RateLimitRule } from './rate-limit';

export interface SecurityRules {
  globalIp: RateLimitRule;
  loginIp: RateLimitRule;
  loginIdentity: RateLimitRule;
  recoveryIp: RateLimitRule;
}

export interface SecurityOptions {
  isProduction: boolean;
  pepper: string;
  csrfSecret: string;
  allowedOrigins: string[];
  limiter: RateLimiter;
  rules: SecurityRules;
}

export interface SecurityOverrides {
  limiter?: RateLimiter;
  rules?: Partial<SecurityRules>;
  allowedOrigins?: string[];
  pepper?: string;
  csrfSecret?: string;
}

export function createSecurityOptions(
  env: AppEnv,
  overrides: SecurityOverrides = {}
): SecurityOptions {
  const isProduction = env.NODE_ENV === 'production';
  if (isProduction) {
    if (env.AUTH_PEPPER === undefined || env.AUTH_PEPPER.length < 32) {
      throw new EnvironmentError('AUTH_PEPPER (>= 32 chars) is required in production');
    }
    if (env.CSRF_SECRET === undefined || env.CSRF_SECRET.length < 32) {
      throw new EnvironmentError('CSRF_SECRET (>= 32 chars) is required in production');
    }
  }
  const pepper = overrides.pepper ?? env.AUTH_PEPPER ?? DEV_PEPPER;
  const csrfSecret = overrides.csrfSecret ?? env.CSRF_SECRET ?? DEV_CSRF_SECRET;
  const allowedOrigins =
    overrides.allowedOrigins ??
    (env.PUBLIC_APP_ORIGIN === undefined
      ? []
      : env.PUBLIC_APP_ORIGIN.split(',')
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0));
  return {
    isProduction,
    pepper,
    csrfSecret,
    allowedOrigins,
    limiter: overrides.limiter ?? new RateLimiter(),
    rules: { ...DEFAULT_RATE_RULES, ...overrides.rules },
  };
}
