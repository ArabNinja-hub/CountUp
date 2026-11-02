import type { QueryExecutor, QueryResultRow } from '../../src/db/query-executor';

/**
 * Fault injection for C-10. Wraps an executor so that ONLY the audit INSERT
 * fails, including inside transactions: `transaction` is overridden to pass a
 * wrapped transactional executor to the callback. Nothing in production code is
 * modified; this is a pure test double.
 */
export function withFailingAudit(executor: QueryExecutor): QueryExecutor {
  const wrap = (inner: QueryExecutor): QueryExecutor => ({
    async query<Row extends QueryResultRow = QueryResultRow>(
      sql: string,
      values?: readonly unknown[]
    ): Promise<{ rows: Row[] }> {
      if (/INSERT\s+INTO\s+platform_audit/i.test(sql)) {
        throw new Error('simulated audit write failure');
      }
      return inner.query<Row>(sql, values);
    },
    async exec(sql: string): Promise<void> {
      return inner.exec(sql);
    },
    transaction<T>(work: (tx: QueryExecutor) => Promise<T>): Promise<T> {
      return inner.transaction((tx) => work(wrap(tx)));
    },
  });
  return wrap(executor);
}
