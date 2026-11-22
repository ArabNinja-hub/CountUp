/**
 * PBKDF2-HMAC-SHA256 iteration counts:
 * - SERVER_PBKDF2_ITERATIONS (210,000): OWASP PBKDF2-HMAC-SHA256 standard,
 *   combined with a server-only secret pepper (`COUNTUP_PIN_PEPPER`). Runs in
 *   ~12–25 ms on Edge Function server CPUs.
 * - LOCAL_PBKDF2_ITERATIONS (120,000): Used for same-device offline screen
 *   unlock in browser WebCrypto (`src/utils/pinLock.ts`). Above the 100,000
 *   minimum floor while keeping unlock latency ~55–85 ms on 64-bit budget
 *   Android phones and ~180–260 ms on 32-bit Cortex-A53 Android Go phones.
 */
export const SERVER_PBKDF2_ITERATIONS = 210_000;
export const LOCAL_PBKDF2_ITERATIONS = 120_000;
export const DEFAULT_PBKDF2_ITERATIONS = SERVER_PBKDF2_ITERATIONS;

const DEFAULT_TRIAL_PHONE_SALT_HEX = '636f756e7475705f747269616c5f7632'; // ASCII "countup_trial_v2"
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 unambiguous chars

function getSubtleCrypto(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error('WebCrypto API is unavailable in this environment.');
  }
  return globalThis.crypto.subtle;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('Invalid hexadecimal encoding.');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function generateSaltHex(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/** Constant-time hexadecimal string comparison to prevent timing side-channels. */
export function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Derive a 256-bit PBKDF2-SHA256 hash using WebCrypto.
 * Server-side Edge Functions pass a private `pepper` secret; client-side
 * offline screen locks leave `pepper` empty and use a distinct domain prefix.
 */
export async function deriveSecretHashHex(
  secret: string,
  saltHex: string,
  options: { pepper?: string; domain?: string; iterations?: number } = {}
): Promise<string> {
  const subtle = getSubtleCrypto();
  const iterations = options.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
  const domain = options.domain ?? 'countup-pin-v2';
  const material = options.pepper
    ? `${domain}:${secret}:${options.pepper}`
    : `${domain}:local:${secret}`;

  const encoder = new TextEncoder();
  const keyMaterial = await subtle.importKey(
    'raw',
    encoder.encode(material),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const saltBytes = hexToBytes(saltHex);
  const bits = await subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: saltBytes as BufferSource,
      iterations,
    },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

export async function verifySecretHash(
  candidate: string,
  saltHex: string,
  expectedHashHex: string,
  options: { pepper?: string; domain?: string; iterations?: number } = {}
): Promise<boolean> {
  const actual = await deriveSecretHashHex(candidate, saltHex, options);
  return constantTimeEqualHex(actual.toLowerCase(), expectedHashHex.toLowerCase());
}

/**
 * Deterministic salted + peppered PBKDF2-SHA256 hash of a canonical +260 phone
 * number for `used_trial_phones` so raw phone numbers are never stored in the
 * trial/suspension retention table.
 */
export async function hashPhoneForTrialGuard(
  canonicalPhoneE164: string,
  pepper: string,
  options: { saltHex?: string; iterations?: number } = {}
): Promise<string> {
  const cleanPhone = normalizeZambianPhoneE164(canonicalPhoneE164);
  const cleanPepper = pepper.trim();
  if (cleanPepper.length < 16) {
    throw new Error('Server PIN pepper must be at least 16 characters.');
  }
  const saltHex = options.saltHex?.trim() || DEFAULT_TRIAL_PHONE_SALT_HEX;
  return deriveSecretHashHex(cleanPhone, saltHex, {
    pepper: cleanPepper,
    domain: 'countup-used-trial-phone-v2',
    iterations: options.iterations ?? SERVER_PBKDF2_ITERATIONS,
  });
}

/**
 * Keyed HMAC-SHA256 digest for rate-limiting identifiers (phone or client IP)
 * so `sms_rate_events` never stores raw phone numbers or raw IP addresses.
 */
export async function hashRateLimitIdentifier(
  rawIdentifier: string,
  pepper: string,
  namespace: 'phone' | 'ip'
): Promise<string> {
  const cleanPepper = pepper.trim();
  if (cleanPepper.length < 16) {
    throw new Error('Server PIN pepper must be at least 16 characters.');
  }
  const subtle = getSubtleCrypto();
  const encoder = new TextEncoder();
  const key = await subtle.importKey(
    'raw',
    encoder.encode(`countup-ratelimit-v2:${namespace}:${cleanPepper}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const normalized = rawIdentifier.trim().toLowerCase();
  const sig = await subtle.sign('HMAC', key, encoder.encode(normalized));
  return bytesToHex(new Uint8Array(sig));
}

/** Generate a human-writable one-time recovery code: CU-XXXX-XXXX-XXXX. */
export function generateOneTimeRecoveryCode(): string {
  const chars: string[] = [];
  const random = new Uint8Array(12);
  globalThis.crypto.getRandomValues(random);
  for (let i = 0; i < 12; i++) {
    // 32 divides 256 evenly, so `& 31` has zero modulo bias.
    chars.push(RECOVERY_ALPHABET[random[i] & 31]);
  }
  return `CU-${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}`;
}

export function normalizeRecoveryCode(raw: string): string {
  const compact = raw
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '');
  const body = compact.startsWith('CU') ? compact.slice(2) : compact;
  if (!/^[A-HJ-NP-Z2-9]{12}$/.test(body)) {
    throw new Error('Enter a valid recovery code (for example CU-XXXX-XXXX-XXXX).');
  }
  return `CU-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

export function isValidFourDigitPin(pin: string): boolean {
  return /^\d{4}$/.test(pin);
}

/** Canonical E.164 Zambian mobile phone (+26095/96/97/75/76/77 + 7 digits). */
export function normalizeZambianPhoneE164(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  let subscriber = '';
  if (digits.length === 10 && digits.startsWith('0')) {
    subscriber = digits.slice(1);
  } else if (digits.length === 12 && digits.startsWith('260')) {
    subscriber = digits.slice(3);
  } else if (digits.length === 9) {
    subscriber = digits;
  }
  if (!/^(9[5-7]|7[5-7])\d{7}$/.test(subscriber)) {
    throw new Error('Enter a valid Zambian mobile number (MTN, Airtel, or Zamtel).');
  }
  return `+260${subscriber}`;
}

export function validateShopName(raw: string): string {
  const clean = raw.trim();
  if (clean.length < 1 || clean.length > 120) {
    throw new Error('Enter a shop name between 1 and 120 characters.');
  }
  return clean;
}

export function validateIdentityCheckNote(raw: string): string {
  const clean = raw.trim();
  if (clean.length < 10 || clean.length > 500) {
    throw new Error(
      'Record how the shop owner’s identity was verified (between 10 and 500 characters).'
    );
  }
  return clean;
}

/** Escalating per-shop server lockout delays for new-device PIN or recovery-code attempts. */
export function calculateNewDeviceLockoutMs(failedAttempts: number): number {
  if (failedAttempts < 5) return 0;
  if (failedAttempts === 5) return 5 * 60_000;
  if (failedAttempts === 6) return 15 * 60_000;
  if (failedAttempts === 7) return 60 * 60_000;
  return 24 * 60 * 60_000;
}

/** Escalating local screen-lock delays on the phone itself (offline). */
export function calculateLocalScreenLockoutMs(failedAttempts: number): number {
  if (failedAttempts < 5) return 0;
  if (failedAttempts === 5) return 30_000;
  if (failedAttempts === 6) return 2 * 60_000;
  if (failedAttempts === 7) return 10 * 60_000;
  return 30 * 60_000;
}
