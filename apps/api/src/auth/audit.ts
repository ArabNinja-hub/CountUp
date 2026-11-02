import type { QueryExecutor } from '../db/query-executor';
import { assertAuditPayload } from './audit-evidence';

export interface SecurityAuditEvent {
  action: string;
  actorUserId?: string | null;
  actorRole?: string | null;
  actorIp?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  shopId?: string | null;
  /** C-09: strict allowlist, bounded and free of raw PII. Never tokens/passwords. */
  payload?: Record<string, unknown>;
}

/**
 * Writes to the append-only `platform_audit` table (M1 `deny_mutation()` trigger).
 *
 * C-10: this function is intended to be called with a TRANSACTIONAL executor.
 * Validation happens before the INSERT so a rejected payload rolls back the
 * security-critical state change in the same transaction instead of leaving a
 * half-logged mutation behind.
 */
export async function writeSecurityAudit(
  executor: QueryExecutor,
  event: SecurityAuditEvent
): Promise<void> {
  const payload = event.payload ?? {};
  assertAuditPayload(payload);
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
      payload,
    ]
  );
}
