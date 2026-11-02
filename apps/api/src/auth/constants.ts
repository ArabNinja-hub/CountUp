import type { Algorithm } from '@node-rs/argon2';

// `Algorithm` is a `const enum`, which cannot be referenced at runtime under
// `isolatedModules`. Argon2id is numeric value 2 in the napi binding.
const ARGON2ID = 2 as Algorithm;

/** 256-bit opaque tokens (ADR-01). */
export const TOKEN_BYTES = 32;

export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1024;

export const SESSION_COOKIE = 'countup_session';
export const REFRESH_COOKIE = 'countup_refresh';
export const CSRF_COOKIE = 'countup_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export const PASSWORD_ALGO = 'argon2id';

/** Non-secret development fallbacks. Production MUST supply real env secrets. */
export const DEV_PEPPER = '__COUNTUP_DEV_ONLY_NOT_A_SECRET_PEPPER__';
export const DEV_CSRF_SECRET = '__COUNTUP_DEV_ONLY_NOT_A_SECRET_CSRF__';
