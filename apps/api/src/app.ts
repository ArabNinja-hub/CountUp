import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AppEnv } from './config/env';
import type { QueryExecutor, QueryResultRow } from './db/query-executor';
import { RequestValidationError, parseWith, validateBody } from './http/validate';

export interface AppOptions {
  env: AppEnv;
  /** Optional so the app can boot without a database during M0/M1. */
  db?: QueryExecutor;
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
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));

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

  // Foundation validation smoke route. No auth, no persistence, no business logic.
  // It exists solely so Zod request validation is exercised end-to-end in M0/M1 and
  // should be removed when the first real M2 endpoint is introduced.
  app.post(
    '/v1/echo',
    validateBody(echoBodySchema),
    (req: Request<unknown, unknown, z.output<typeof echoBodySchema>>, res: Response) => {
      res.status(200).json({ message: req.body.message });
    }
  );

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
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
    console.error('[countup-api] unhandled error', error);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
