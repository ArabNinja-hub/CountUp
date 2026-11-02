import type { Client, Pool, QueryResult } from 'pg';
import type { PGlite, Transaction } from '@electric-sql/pglite';

export interface QueryResultRow {
  [column: string]: unknown;
}

/**
 * The only SQL surface used by the backend. `query` is for ONE parameterised
 * statement; `exec` is for the multi-statement SQL in a migration file. Values are
 * always passed as bind parameters - no SQL string is ever built from user input.
 */
export interface QueryExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: readonly unknown[]
  ): Promise<{ rows: Row[] }>;
  exec(sql: string): Promise<void>;
  transaction<T>(work: (tx: QueryExecutor) => Promise<T>): Promise<T>;
}

/**
 * BEGIN / COMMIT on a single connection. Both adapters below are single-connection,
 * so this is safe; a pool adapter checks out one client for the whole transaction.
 */
export async function runTransaction<T>(
  executor: QueryExecutor,
  work: (tx: QueryExecutor) => Promise<T>
): Promise<T> {
  await executor.query('BEGIN');
  try {
    const result = await work(executor);
    await executor.query('COMMIT');
    return result;
  } catch (error) {
    await executor.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

type PgliteLike = PGlite | Transaction;

/** Isolated in-memory PostgreSQL for tests. Never reads DATABASE_URL. */
export function createPgliteExecutor(db: PgliteLike): QueryExecutor {
  const executor: QueryExecutor = {
    async query<Row extends QueryResultRow>(sql: string, values: readonly unknown[] = []) {
      const result = await db.query<Row>(sql, values as unknown[]);
      return { rows: result.rows as Row[] };
    },
    async exec(sql: string) {
      await db.exec(sql);
    },
    transaction<T>(work: (tx: QueryExecutor) => Promise<T>) {
      return runTransaction(executor, work);
    },
  };
  return executor;
}

function pgRows<Row extends QueryResultRow>(result: QueryResult): Row[] {
  return result.rows as Row[];
}

/** One dedicated `pg` Client - used by the migration CLI. */
export function createPgClientExecutor(client: Client): QueryExecutor {
  const executor: QueryExecutor = {
    async query<Row extends QueryResultRow>(sql: string, values: readonly unknown[] = []) {
      const result = await client.query(sql, values as unknown[]);
      return { rows: pgRows<Row>(result) };
    },
    async exec(sql: string) {
      await client.query(sql);
    },
    transaction<T>(work: (tx: QueryExecutor) => Promise<T>) {
      return runTransaction(executor, work);
    },
  };
  return executor;
}

/** Application runtime pool. Transactions borrow exactly one client for their duration. */
export function createPgPoolExecutor(pool: Pool): QueryExecutor {
  return {
    async query<Row extends QueryResultRow>(sql: string, values: readonly unknown[] = []) {
      const result = await pool.query(sql, values as unknown[]);
      return { rows: pgRows<Row>(result) };
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    async transaction<T>(work: (tx: QueryExecutor) => Promise<T>) {
      const client = await pool.connect();
      try {
        return await runTransaction(createPgClientExecutor(client), work);
      } finally {
        client.release();
      }
    },
  };
}
