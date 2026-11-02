import type { QueryExecutor, QueryResultRow } from '../db/query-executor';
import { assertSafeAuditText, parseAuditEvidence, type AuditEvidence } from './audit-evidence';
import { writeSecurityAudit } from './audit';
import { authErrors } from './errors';
import { assertAdminTargetAllowed } from './roles';

export interface VerificationDecision {
  actorUserId: string;
  targetUserId: string;
  decision: 'approved' | 'rejected';
  evidence: unknown;
  notes?: string;
  actorIp?: string | null;
}

export interface VerificationResult {
  status: string;
  verificationId: string;
}

interface UserStateRow extends QueryResultRow {
  id: string;
  identity_status: string;
}

/**
 * Replaceable port (ADR-02). The pilot implementation is admin-assisted and has
 * NO SMS/email delivery dependency. An OTP provider can be added later by supplying
 * another implementation without changing AuthService or the routes.
 */
export interface IdentityVerifier {
  readonly kind: string;
  recordRequest(executor: QueryExecutor, userId: string, ip: string | null): Promise<void>;
  decide(executor: QueryExecutor, input: VerificationDecision): Promise<VerificationResult>;
}

export class AdminAssistedIdentityVerifier implements IdentityVerifier {
  readonly kind = 'admin_assisted_v1';

  async recordRequest(executor: QueryExecutor, userId: string, ip: string | null): Promise<void> {
    // C-09: no raw IP or free-form client object in the immutable evidence column.
    const evidence: AuditEvidence = parseAuditEvidence({});
    await executor.query(
      `INSERT INTO identity_verifications (user_id, status, decision, evidence)
       VALUES ($1, 'pending_review', 'requested', $2)`,
      [userId, evidence]
    );
    await writeSecurityAudit(executor, {
      action: 'identity.verification_requested',
      actorUserId: userId,
      actorRole: 'owner',
      actorIp: ip,
      targetType: 'users',
      targetId: userId,
      payload: { mechanism: this.kind },
    });
  }

  async decide(executor: QueryExecutor, input: VerificationDecision): Promise<VerificationResult> {
    // C-05: trusted server-side role check + separation of duties.
    const { actor } = await assertAdminTargetAllowed(
      executor,
      input.actorUserId,
      input.targetUserId
    );
    // C-09: strict allowlist, also enforced for direct service-level callers.
    const evidence = parseAuditEvidence(input.evidence);
    if (input.notes !== undefined) {
      assertSafeAuditText(input.notes);
    }

    const status = input.decision === 'approved' ? 'verified' : 'rejected';

    // C-06 + C-10: the state transition, the immutable decision row and the
    // platform_audit row are ONE transaction. `users.identity_status` is the
    // single authoritative state; every marker is derived from it.
    return executor.transaction(async (tx) => {
      const current = await tx.query<UserStateRow>(
        'SELECT id, identity_status::text AS identity_status FROM users WHERE id = $1 FOR UPDATE',
        [input.targetUserId]
      );
      const row = current.rows[0];
      if (row === undefined) {
        throw authErrors.forbidden();
      }
      if (row.identity_status === status) {
        throw authErrors.forbidden(); // idempotency: no duplicate decision for the same state
      }

      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO identity_verifications
           (user_id, status, decision, evidence, notes, reviewed_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [input.targetUserId, status, input.decision, evidence, input.notes ?? null, actor.id]
      );
      const verificationId = inserted.rows[0]?.id;
      if (verificationId === undefined) {
        throw new Error('identity verification insert returned no id');
      }

      if (status === 'verified') {
        await tx.query(
          `UPDATE users
              SET identity_status = 'verified',
                  identity_verified_at = now(),
                  identity_verified_by = $2
            WHERE id = $1`,
          [input.targetUserId, actor.id]
        );
        await tx.query(
          'UPDATE auth_identities SET verified_at = now() WHERE user_id = $1 AND is_primary',
          [input.targetUserId]
        );
      } else {
        // Clear ALL trust markers. A rejected identity must have no verified_at,
        // no verifier reference and no verified identity records.
        await tx.query(
          `UPDATE users
              SET identity_status = 'rejected',
                  identity_verified_at = NULL,
                  identity_verified_by = NULL
            WHERE id = $1`,
          [input.targetUserId]
        );
        await tx.query('UPDATE auth_identities SET verified_at = NULL WHERE user_id = $1', [
          input.targetUserId,
        ]);
      }

      await writeSecurityAudit(tx, {
        action:
          input.decision === 'approved'
            ? 'identity.verification_approved'
            : 'identity.verification_rejected',
        actorUserId: actor.id,
        actorRole: actor.role,
        actorIp: input.actorIp ?? null,
        targetType: 'users',
        targetId: input.targetUserId,
        payload: { mechanism: this.kind, verification_id: verificationId },
      });
      return { status, verificationId };
    });
  }
}
