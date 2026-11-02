import { randomBytes } from 'node:crypto';
import { loadEnv, type AppEnv } from '../src/config/env';

/**
 * C-04: tests inject explicitly generated secrets, exactly like a deployment.
 * No fallback secret exists in the codebase. The fixed prefixes guarantee the
 * values never look like an example/development placeholder and are distinct.
 */
export const TEST_AUTH_PEPPER = `Zq9_${randomBytes(36).toString('base64url')}`;
export const TEST_CSRF_SECRET = `Kp7_${randomBytes(36).toString('base64url')}`;

export function testEnv(extra: NodeJS.ProcessEnv = {}): AppEnv {
  return loadEnv({
    NODE_ENV: 'test',
    AUTH_PEPPER: TEST_AUTH_PEPPER,
    CSRF_SECRET: TEST_CSRF_SECRET,
    ...extra,
  });
}
