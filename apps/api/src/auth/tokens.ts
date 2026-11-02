import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { TOKEN_BYTES } from './constants';

/** 32 random bytes = 256 bits, base64url encoded for safe cookie/header transport. */
export function generateOpaqueToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Only ever persisted/compared as a SHA-256 digest — never the raw token. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** For audit payloads: identifiers are hashed so raw emails/phones are not logged. */
export function hashIdentifier(identifier: string): string {
  return createHash('sha256').update(identifier.toLowerCase(), 'utf8').digest('hex');
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function normalisePhone(value: string): string {
  return value.replace(/[^+\d]/g, '');
}

export function normaliseIp(value: string | undefined | null): string | null {
  if (value === undefined || value === null || value.length === 0) {
    return null;
  }
  if (value === '::1') {
    return '127.0.0.1';
  }
  return value.startsWith('::ffff:') ? value.slice(7) : value;
}
