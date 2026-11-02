import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AppEnv } from './config/env';
import type { QueryExecutor, QueryResultRow } from './db/query-executor';
import { RequestValidationError, parseWith, validateBody } from './http/validate';
import { AuthService } from './auth/auth-service';
import { createCsrfToken } from './auth/csrf';
import { setCsrfCookie } from './auth/cookies';
import { AuthError } from './auth/errors';
import { AdminAssistedIdentityVerifier } from './auth/identity-verifier';
import { csrfGuard, noStore, originGuard } from './auth/middleware';
import { PasswordHasher } from './auth/password';
import { InMemoryRateLimiter, PostgresRateLimiter } from './auth/rate-limit';
import { createAuthRouter } from './auth/routes';
import {
  createSecurityOptions,
  type SecurityOverrides,
  type SecurityOptions,
} from './auth/security';

export interface AppOptions {
  env: AppEnv;
  /** Optional so the app can boot without a database during M0/M1. */
  db?: QueryExecutor;
  /** Test/CI overrides for rate limits, secrets and allowed origins. */
  security?: SecurityOverrides;
  /** Injectable for tests; built from `db` + env when omitted. */
  auth?: AuthService;
}

const readyQuerySchema = z.object({
  verbose: z.enum(['0', '1']).optional(),
});

const echoBodySchema = z.object({
  message: z.string().min(1).max(200),
});

interface HealthyRow extends QueryResultRow {
  healthy: number;
}

export function createApp(options: AppOptions): express.Express {
  const { env, db } = options;
  // C-03: the runtime limiter is ALWAYS shared PostgreSQL state when a DB is
  // configured. The in-memory implementation is only for a DB-less health boot.
  const securityOverrides: SecurityOverrides = {
    ...options.security,
    limiter:
      options.security?.limiter ??
      (db === undefined ? new InMemoryRateLimiter() : new PostgresRateLimiter(db)),
  };
  const security: SecurityOptions = createSecurityOptions(env, securityOverrides);
  const service: AuthService | undefined =
    options.auth ??
    (db === undefined
      ? undefined
      : new AuthService({
          executor: db,
          passwordHasher: new PasswordHasher(security.pepper),
          verifier: new AdminAssistedIdentityVerifier(),
        }));

  const app = express();
  app.disable('x-powered-by');
  // Forwarded headers are trusted ONLY with an explicit hop count from config.
  if (security.trustProxyHops !== null) {
    app.set('trust proxy', security.trustProxyHops);
  }
  app.use(express.json({ limit: '32kb' }));
  app.use(noStore);
  app.use(originGuard(security));
  app.use(csrfGuard(security));

  // C-04: explicit deployment decision, not a NODE_ENV guess.
  const cookiePolicy = { secure: security.secureCookies };

  app.get('/auth/csrf', (_req: Request, res: Response) => {
    const token = createCsrfToken(security.csrfSecret);
    setCsrfCookie(res, token, cookiePolicy);
    res.status(200).json({ csrfToken: token });
  });

  app.get('/health/live', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      service: 'countup-api',
      version: env.APP_VERSION,
      environment: env.NODE_ENV,
    });
  });

  app.get('/health/ready', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { verbose } = parseWith(readyQuerySchema, req.query);
      if (db === undefined) {
        res.status(503).json({ status: 'unavailable', database: 'not configured' });
        return;
      }
      const { rows } = await db.query<HealthyRow>('SELECT 1 AS healthy');
      res.status(200).json({
        status: rows[0]?.healthy === 1 ? 'ready' : 'degraded',
        ...(verbose === '1' ? { environment: env.NODE_ENV } : {}),
      });
    } catch (error) {
      next(error);
    }
  });

  // Foundation validation smoke route (stateless; CSRF + Origin guarded like all
  // other unsafe methods). Retained from M0/M1 for regression coverage.
  app.post(
    '/v1/echo',
    validateBody(echoBodySchema),
    (req: Request<unknown, unknown, z.output<typeof echoBodySchema>>, res: Response) => {
      res.status(200).json({ message: req.body.message });
    }
  );

  if (service !== undefined) {
    app.use('/auth', createAuthRouter({ service, security, env }));
  }

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AuthError) {
      res.status(error.status).json({
        error: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      });
      return;
    }
    if (error instanceof RequestValidationError) {
      res.status(400).json({ error: 'validation_error', details: error.details });
      return;
    }
    if (error instanceof SyntaxError) {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }
    const status =
      typeof error === 'object' && error !== null && 'status' in error
        ? (error as { status?: unknown }).status
        : undefined;
    if (status === 413) {
      res.status(413).json({ error: 'payload_too_large' });
      return;
    }
    // H-06: never log whole error objects (PGlite errors expose bound `params`).
    const name = error instanceof Error ? error.name : typeof error;
    console.error(`[countup-api] unhandled ${name}`);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
