import { PGlite } from '@electric-sql/pglite';
import { migrateUp } from '../src/db/migrations';
import { createPgliteExecutor, type QueryExecutor } from '../src/db/query-executor';

export interface IsolatedDatabase {
  db: PGlite;
  executor: QueryExecutor;
  close(): Promise<void>;
}

/**
 * The ONLY database the test suite ever talks to: a fresh, in-memory PGlite instance
 * (PostgreSQL 18.6 compiled to WASM). It has no dataDir, no TCP listener and no wire
 * protocol, so it cannot reach a development, staging or production database. It never
 * reads DATABASE_URL or TEST_DATABASE_URL.
 */
export async function createIsolatedDatabase(): Promise<IsolatedDatabase> {
  const db = new PGlite();
  await db.waitReady;
  return {
    db,
    executor: createPgliteExecutor(db),
    async close() {
      await db.close();
    },
  };
}

export async function createMigratedDatabase(): Promise<IsolatedDatabase> {
  const handle = await createIsolatedDatabase();
  await migrateUp(handle.executor);
  return handle;
}

export async function expectSqlError(statement: Promise<unknown>, code: string): Promise<string> {
  try {
    await statement;
  } catch (error) {
    const actual = (error as { code?: unknown }).code;
    if (actual !== code) {
      throw new Error(`Expected SQLSTATE ${code} but got ${String(actual)}: ${String(error)}`);
    }
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`Expected SQLSTATE ${code}, but the statement succeeded`);
}

export function firstRow<Row>(rows: Row[], label: string): Row {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Expected at least one row from: ${label}`);
  }
  return row;
}
