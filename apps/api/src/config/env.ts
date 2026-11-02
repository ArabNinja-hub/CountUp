import { z } from 'zod';

/**
 * Deployment configuration ONLY. Business settings (trial length, currency, grace
 * period, timezone ...) live in the `system_config` table, not here. See
 * packages/shared/src/system-config.ts and migrations/0001_foundation.up.sql.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  APP_VERSION: z.string().min(1).default('0.1.0'),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (value) => /^postgres(ql)?:\/\//.test(value),
      'must be a postgres:// or postgresql:// URL'
    )
    .optional(),
  MIGRATIONS_DIR: z.string().min(1).optional(),
});

export type AppEnv = z.output<typeof envSchema>;

export class EnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentError';
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new EnvironmentError(`Invalid backend environment:\n${details}`);
  }
  return parsed.data;
}
