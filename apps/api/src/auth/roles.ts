import type { QueryExecutor, QueryResultRow } from '../db/query-executor';
import { authErrors } from './errors';

interface ActorRow extends QueryResultRow {
  id: string;
  role: string;
  status: string;
}

export interface TrustedActor {
  id: string;
  role: string;
  status: string;
}

/** Roles are ALWAYS read from PostgreSQL, never from a client-supplied value. */
export async function loadTrustedActor(
  executor: QueryExecutor,
  userId: string
): Promise<TrustedActor | null> {
  const { rows } = await executor.query<ActorRow>(
    'SELECT id, role, status FROM users WHERE id = $1',
    [userId]
  );
  return rows[0] ?? null;
}

export async function assertPlatformAdmin(
  executor: QueryExecutor,
  userId: string
): Promise<TrustedActor> {
  const actor = await loadTrustedActor(executor, userId);
  if (actor === null || actor.role !== 'platform_admin' || actor.status !== 'active') {
    throw authErrors.forbidden();
  }
  return actor;
}
