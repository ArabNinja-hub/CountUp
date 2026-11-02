import type { QueryExecutor } from '../db/query-executor';
import { writeSecurityAudit } from './audit';
import { authErrors } from './errors';
import { assertPlatformAdmin } from './roles';

export interface VerificationDecision {
  actorUserId: string;
  targetUserId: string;
  decision: 'approved' | 'rejected';
  evidence: Record<string, unknown>;
  notes?: string;
  actorIp?: string | null;
}

export interface VerificationResult {
  status: string;
  verificationId: string;
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
    await executor.query(
      `INSERT INTO identity_verifications (user_id, status, decision, evidence)
       VALUES ($1, 'pending_review', 'requested', $2)`,
      [userId, { source: 'signup', requested_ip: ip }]
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
    // Trusted server-side role check. A caller cannot forge admin status.
    const actor = await assertPlatformAdmin(executor, input.actorUserId);

    const target = await executor.query<{ id: string }>('SELECT id FROM users WHERE id = $1', [
      input.targetUserId,
    ]);
    if (target.rows[0] === undefined) {
      throw authErrors.forbidden();
    }

    const status = input.decision === 'approved' ? 'verified' : 'rejected';
    return executor.transaction(async (tx) => {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO identity_verifications
           (user_id, status, decision, evidence, notes, reviewed_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [input.targetUserId, status, input.decision, input.evidence, input.notes ?? null, actor.id]
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
        await tx.query(`UPDATE users SET identity_status = 'rejected' WHERE id = $1`, [
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
