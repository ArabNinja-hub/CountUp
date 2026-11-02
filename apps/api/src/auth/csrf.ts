import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constantTimeEqual } from './tokens';

const CSRF_CONTEXT = 'countup-csrf-v1';

function mac(secret: string, nonce: string): Buffer {
  return createHmac('sha256', secret).update(`${CSRF_CONTEXT}:${nonce}`).digest();
}

/** Signed double-submit token: nonce + HMAC(secret, nonce). No server-side state. */
export function createCsrfToken(secret: string): string {
  const nonce = randomBytes(32).toString('base64url');
  return `${nonce}.${mac(secret, nonce).toString('base64url')}`;
}

export function isValidCsrfSignature(secret: string, token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
    return false;
  }
  let provided: Buffer;
  try {
    provided = Buffer.from(parts[1], 'base64url');
  } catch {
    return false;
  }
  const expected = mac(secret, parts[0]);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** Cookie value must equal the header value AND carry a valid signature. */
export function isDoubleSubmitValid(
  secret: string,
  cookieValue: string | undefined,
  headerValue: string | undefined
): boolean {
  if (cookieValue === undefined || headerValue === undefined) {
    return false;
  }
  if (!constantTimeEqual(cookieValue, headerValue)) {
    return false;
  }
  return isValidCsrfSignature(secret, cookieValue);
}
