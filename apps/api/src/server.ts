import { Pool } from 'pg';
import { createApp } from './app';
import { loadEnv } from './config/env';
import { createPgPoolExecutor } from './db/query-executor';

const env = loadEnv();
const pool =
  env.DATABASE_URL === undefined
    ? undefined
    : new Pool({ connectionString: env.DATABASE_URL, max: 5 });

const app = createApp({
  env,
  ...(pool === undefined ? {} : { db: createPgPoolExecutor(pool) }),
});

const server = app.listen(env.PORT, '0.0.0.0', () => {
  console.log(
    `[countup-api] listening on 0.0.0.0:${env.PORT} (${env.NODE_ENV}); database ${
      pool === undefined ? 'not configured' : 'configured'
    }`
  );
});

async function shutdown(): Promise<void> {
  server.close();
  await pool?.end();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}
