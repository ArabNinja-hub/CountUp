import { z } from 'zod';
import { AuthError } from './errors';

/**
 * C-09. Audit evidence is written into APPEND-ONLY tables (`platform_audit`,
 * `identity_verifications`), so a bad row can never be erased. Client-controlled
 * objects are therefore replaced by a strict allowlist: fixed keys, bounded
 * strings, no free-form objects, no nested personal data.
 *
 * Deliberately absent: email, phone, national ID / NRC number, date of birth,
 * address, passwords, hints, tokens, secrets, PINs and arbitrary notes.
 * A document reference must be supplied as a SHA-256 digest, never the raw ID.
 */
export const auditEvidenceSchema = z
  .strictObject({
    verification_method: z
      .enum(['in_person', 'document_check', 'call_back', 'operator_handoff'])
      .optional(),
    document_type: z.enum(['nrc', 'passport', 'drivers_licence', 'none']).optional(),
    document_reference_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/, 'must be a lowercase SHA-256 hex digest')
      .optional(),
    reviewer_note: z.string().max(120).optional(),
    channel: z.enum(['in_person', 'call_back', 'operator_handoff']).optional(),
    id_checked: z.boolean().optional(),
    recovery_reference_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/, 'must be a lowercase SHA-256 hex digest')
      .optional(),
  })
  .refine((value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 512, {
    message: 'evidence exceeds the 512-byte cap',
  });

export type AuditEvidence = z.output<typeof auditEvidenceSchema>;

/** Strict parser used both by HTTP schemas and by direct service-level callers. */
export function parseAuditEvidence(input: unknown): AuditEvidence {
  const result = auditEvidenceSchema.safeParse(input ?? {});
  if (!result.success) {
    throw new AuthError('validation_error', 400, 'Rejected audit evidence', [
      'evidence contains prohibited, unknown or oversized fields',
    ]);
  }
  return result.data;
}

const FORBIDDEN_KEY =
  /pass(word)?|secret|token|hint|national|nid|ssn|e[-_]?mail|phone|msisdn|pin|dob|birth|address|cookie|pepper|credential|private|api[-_]?key|raw|id[-_]?number|identity[-_]?number|user[-_]?id/i;

// Email / national-ID patterns are scanned anywhere in the string (free-text
// notes can bury PII between ordinary words). The phone pattern stays anchored
// so UUIDs and hashes are not mistaken for phone numbers.
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE_LIKE = /^\+?[0-9][0-9\s\-().]{7,}$/;
const NATIONAL_ID_LIKE = /\d{6}\/\d{2}\/\d{1,2}/;
const HASH_LIKE = /^[a-f0-9]{64}$/;
const ARGON_LIKE = /^\$argon2/i;

const MAX_PAYLOAD_BYTES = 2048;
const MAX_KEYS = 16;
const MAX_STRING_LENGTH = 128;

function auditPolicyError(reason: string): AuthError {
  return new AuthError('validation_error', 400, 'Rejected audit payload', [reason]);
}

/** Rejects raw PII and secret material in any string that reaches an audit row. */
export function assertSafeAuditText(value: string): void {
  if (ARGON_LIKE.test(value)) {
    throw auditPolicyError('password hashes are not permitted in audit records');
  }
  if (HASH_LIKE.test(value)) {
    return; // already pseudonymised
  }
  if (value.length > MAX_STRING_LENGTH) {
    throw auditPolicyError(`string value exceeds ${MAX_STRING_LENGTH} characters`);
  }
  if (EMAIL_LIKE.test(value) || PHONE_LIKE.test(value) || NATIONAL_ID_LIKE.test(value)) {
    throw auditPolicyError('raw personal identifiers are not permitted in audit records');
  }
}

function assertValue(value: unknown, depth: number, keyPath: string): void {
  if (value === null || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value) || Math.abs(value) > 1e12) {
      throw auditPolicyError(`${keyPath} is not a bounded integer`);
    }
    return;
  }
  if (typeof value === 'string') {
    assertSafeAuditText(value);
    return;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    if (depth >= 1) {
      throw auditPolicyError(`${keyPath} has unsupported nesting`);
    }
    assertPayload(value as Record<string, unknown>, depth + 1, keyPath);
    return;
  }
  throw auditPolicyError(`${keyPath} has an unsupported value type`);
}

function assertPayload(payload: Record<string, unknown>, depth: number, parent: string): void {
  const keys = Object.keys(payload);
  if (keys.length > MAX_KEYS) {
    throw auditPolicyError(`${parent} has too many keys`);
  }
  for (const key of keys) {
    const keyPath = parent === '' ? key : `${parent}.${key}`;
    if (FORBIDDEN_KEY.test(key)) {
      throw auditPolicyError(`${keyPath} is a prohibited audit field`);
    }
    if (depth === 1 && key === 'evidence') {
      parseAuditEvidence(payload[key]);
      continue;
    }
    assertValue(payload[key], depth, keyPath);
  }
}

/**
 * Defence in depth for EVERY `writeSecurityAudit` caller, including internal ones
 * that never pass through Zod. Throws a typed 400 so a request is rejected BEFORE
 * the surrounding transaction commits (see C-10).
 */
export function assertAuditPayload(payload: Record<string, unknown> | undefined): void {
  const value = payload ?? {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw auditPolicyError('payload must be a flat object');
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_PAYLOAD_BYTES) {
    throw auditPolicyError(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
  if (value.evidence !== undefined) {
    parseAuditEvidence(value.evidence);
  }
  assertPayload(value, 0, '');
}
