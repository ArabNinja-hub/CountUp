import { EnvironmentError, type AppEnv } from '../config/env';

export interface ResolvedSecrets {
  pepper: string;
  csrfSecret: string;
}

export interface SecretOverrides {
  pepper?: string;
  csrfSecret?: string;
}

const MIN_LENGTH = 32;
const MAX_LENGTH = 512;
const MIN_DISTINCT_CHARACTERS = 12;

// Deliberately rejects anything that looks like a committed example, a labelled
// development fallback, or a trivially guessable value. C-04: there is NO usable
// default secret in deployable configuration.
const UNSAFE_PREFIX =
  /^(?:changeme|change[-_]?me|development|dev(?:elopment)?|test(?:ing)?|example|placeholder|password|secret|default|insecure|countup|not[-_]?a[-_]?secret)/i;
const UNSAFE_FRAGMENT = /(?:__COUNTUP|DEV_ONLY|NOT_A_SECRET|DO_NOT_USE|REPLACE_ME)/i;

/**
 * Fail closed. Every secret must be supplied explicitly (environment or an
 * injected test override), be long enough, and carry basic entropy signals.
 * There is no `NODE_ENV` escape hatch: a staging/preview deployment running with
 * `NODE_ENV=development` gets exactly the same requirement as production.
 */
export function assertStrongSecret(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new EnvironmentError(
      `${name} is required. Supply it from a secret manager; no default secret is shipped.`
    );
  }
  if (value.length < MIN_LENGTH || value.length > MAX_LENGTH) {
    throw new EnvironmentError(`${name} must be ${MIN_LENGTH}-${MAX_LENGTH} characters`);
  }
  if (UNSAFE_PREFIX.test(value) || UNSAFE_FRAGMENT.test(value)) {
    throw new EnvironmentError(`${name} looks like an example or development fallback; refused`);
  }
  if (new Set(value).size < MIN_DISTINCT_CHARACTERS) {
    throw new EnvironmentError(`${name} has too little entropy (repeated characters)`);
  }
  if (/(.)\1{7,}/.test(value)) {
    throw new EnvironmentError(`${name} has too little entropy (long repeated run)`);
  }
  if (/^[a-z]+$/i.test(value) || /^\d+$/.test(value)) {
    throw new EnvironmentError(`${name} must mix character classes`);
  }
  return value;
}

/** Resolves and validates secrets for the API process AND for admin CLI tools. */
export function resolveSecrets(env: AppEnv, overrides: SecretOverrides = {}): ResolvedSecrets {
  const pepper = assertStrongSecret('AUTH_PEPPER', overrides.pepper ?? env.AUTH_PEPPER);
  const csrfSecret = assertStrongSecret('CSRF_SECRET', overrides.csrfSecret ?? env.CSRF_SECRET);
  if (pepper === csrfSecret) {
    throw new EnvironmentError('AUTH_PEPPER and CSRF_SECRET must be distinct values');
  }
  return { pepper, csrfSecret };
}
