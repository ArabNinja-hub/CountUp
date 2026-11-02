import { Client } from 'pg';
import { loadEnv } from '../config/env';
import { DEFAULT_MIGRATIONS_DIR, getMigrationStatus, migrateDown, migrateUp } from './migrations';
import { createPgClientExecutor } from './query-executor';

const USAGE = `Usage: npm run db:<command>
  db:migrate       apply all pending migrations (up)
  db:migrate:down  roll back the most recent migration
  db:status        show applied/pending versions

Requires DATABASE_URL pointing at a NON-PRODUCTION PostgreSQL database.
The CLI refuses to run when NODE_ENV=production. Tests never use this CLI:
they run against a fresh in-memory PGlite database instead.`;

function describeTarget(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.host}${url.pathname}`;
  } catch {
    return '(unparseable URL)';
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== 'up' && command !== 'down' && command !== 'status') {
    throw new Error(`Unknown command ${String(command)}\n\n${USAGE}`);
  }

  const env = loadEnv();
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to run migrations with NODE_ENV=production. M0/M1 is not a production cutover; target a development/staging database explicitly.'
    );
  }
  if (env.DATABASE_URL === undefined) {
    throw new Error(`DATABASE_URL is required for the migration CLI.\n\n${USAGE}`);
  }

  const dir = env.MIGRATIONS_DIR ?? DEFAULT_MIGRATIONS_DIR;
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    const executor = createPgClientExecutor(client);
    console.log(`[countup:migrate] target ${describeTarget(env.DATABASE_URL)} (${env.NODE_ENV})`);
    console.log(`[countup:migrate] migrations ${dir}`);

    if (command === 'up') {
      const applied = await migrateUp(executor, dir);
      console.log(
        applied.length === 0
          ? '[countup:migrate] already up to date'
          : `[countup:migrate] applied ${applied.join(', ')}`
      );
    } else if (command === 'down') {
      const rolledBack = await migrateDown(executor, dir);
      console.log(
        rolledBack === undefined
          ? '[countup:migrate] nothing to roll back'
          : `[countup:migrate] rolled back ${rolledBack}`
      );
    } else {
      for (const entry of await getMigrationStatus(executor, dir)) {
        const state = !entry.applied
          ? 'pending'
          : entry.checksumMatches
            ? 'applied'
            : 'CHECKSUM MISMATCH';
        console.log(`  ${entry.version.padEnd(28)} ${state}`);
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(`[countup:migrate] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
