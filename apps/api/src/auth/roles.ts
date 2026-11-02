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

/**
 * C-05 separation of duties. A platform admin may act on an ordinary owner but
 * NEVER on itself and NEVER on another administrator: a single compromised admin
 * must not be able to verify itself, take over a peer admin, or unilaterally
 * control the whole admin tier. Admin-tier recovery goes through the audited,
 * dual-control break-glass CLI instead.
 */
export async function assertAdminTargetAllowed(
  executor: QueryExecutor,
  actorUserId: string,
  targetUserId: string
): Promise<{ actor: TrustedActor; target: TrustedActor }> {
  const actor = await assertPlatformAdmin(executor, actorUserId);
  if (actor.id === targetUserId) {
    throw authErrors.adminSelfAction();
  }
  const target = await loadTrustedActor(executor, targetUserId);
  if (target === null) {
    throw authErrors.forbidden();
  }
  if (target.role === 'platform_admin') {
    throw authErrors.adminTierProtected();
  }
  return { actor, target };
}
