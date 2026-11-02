import type { QueryExecutor } from '../db/query-executor';

export interface SecurityAuditEvent {
  action: string;
  actorUserId?: string | null;
  actorRole?: string | null;
  actorIp?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  shopId?: string | null;
  /** NEVER put raw tokens, passwords, pepper or full identifiers in here. */
  payload?: Record<string, unknown>;
}

/** Writes to the append-only `platform_audit` table (M1 `deny_mutation()` trigger). */
export async function writeSecurityAudit(
  executor: QueryExecutor,
  event: SecurityAuditEvent
): Promise<void> {
  await executor.query(
    `INSERT INTO platform_audit
       (actor_user_id, actor_role, actor_ip, action, target_type, target_id, shop_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      event.actorUserId ?? null,
      event.actorRole ?? null,
      event.actorIp ?? null,
      event.action,
      event.targetType ?? null,
      event.targetId ?? null,
      event.shopId ?? null,
      event.payload ?? {},
    ]
  );
}
