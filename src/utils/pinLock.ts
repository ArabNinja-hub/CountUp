import {
  calculateLocalScreenLockoutMs,
  deriveSecretHashHex,
  generateSaltHex,
  isValidFourDigitPin,
  LOCAL_PBKDF2_ITERATIONS,
  verifySecretHash,
} from '../../shared/authSecurity';

const LOCAL_PIN_STORAGE_PREFIX = 'countup_pin_lock_v2:';
const SCREEN_LOCKED_STORAGE_KEY = 'countup_screen_locked';
const LOCAL_PIN_DOMAIN = 'countup-local-screen-lock-v2';

export interface StoredLocalPinRecord {
  version: 2;
  shopId: string;
  salt: string;
  hash: string;
  iterations: number;
  failedAttempts: number;
  lockedUntilMs: number | null;
  updatedAt: string;
}

function pinStorageKey(shopId: string): string {
  return `${LOCAL_PIN_STORAGE_PREFIX}${shopId}`;
}

export function readLocalPinRecord(shopId: string): StoredLocalPinRecord | null {
  if (!shopId) return null;
  const raw = localStorage.getItem(pinStorageKey(shopId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredLocalPinRecord>;
    if (
      parsed.version !== 2 ||
      parsed.shopId !== shopId ||
      typeof parsed.salt !== 'string' ||
      typeof parsed.hash !== 'string' ||
      typeof parsed.iterations !== 'number'
    ) {
      return null;
    }
    return {
      version: 2,
      shopId,
      salt: parsed.salt,
      hash: parsed.hash,
      iterations: parsed.iterations,
      failedAttempts: typeof parsed.failedAttempts === 'number' ? parsed.failedAttempts : 0,
      lockedUntilMs: typeof parsed.lockedUntilMs === 'number' ? parsed.lockedUntilMs : null,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function hasLocalPinRecord(shopId: string): boolean {
  return readLocalPinRecord(shopId) !== null;
}

export async function saveLocalPinRecord(
  shopId: string,
  pin: string,
  options?: { iterations?: number }
): Promise<void> {
  if (!shopId) throw new Error('Missing shop identifier for PIN lock.');
  if (!isValidFourDigitPin(pin)) {
    throw new Error('PIN must be 4 digits.');
  }
  const iterations = options?.iterations ?? LOCAL_PBKDF2_ITERATIONS;
  const salt = generateSaltHex();
  const hash = await deriveSecretHashHex(pin, salt, {
    domain: `${LOCAL_PIN_DOMAIN}:${shopId}`,
    iterations,
  });
  const record: StoredLocalPinRecord = {
    version: 2,
    shopId,
    salt,
    hash,
    iterations,
    failedAttempts: 0,
    lockedUntilMs: null,
    updatedAt: new Date().toISOString(),
  };
  localStorage.setItem(pinStorageKey(shopId), JSON.stringify(record));
}

export function getLocalLockoutRemainingMs(shopId: string, nowMs = Date.now()): number {
  const record = readLocalPinRecord(shopId);
  if (!record?.lockedUntilMs) return 0;
  return Math.max(0, record.lockedUntilMs - nowMs);
}

export interface LocalPinVerificationResult {
  unlocked: boolean;
  lockedOut: boolean;
  remainingLockoutMs: number;
  failedAttempts: number;
}

/**
 * Verifies the 4-digit PIN locally on the same device using salted WebCrypto PBKDF2
 * with escalating local lockout delays. Works 100% offline and never touches
 * server lockout counters.
 */
export async function verifyLocalPin(
  shopId: string,
  pin: string,
  nowMs = Date.now()
): Promise<LocalPinVerificationResult> {
  const record = readLocalPinRecord(shopId);
  if (!record) {
    return {
      unlocked: false,
      lockedOut: false,
      remainingLockoutMs: 0,
      failedAttempts: 0,
    };
  }

  if (record.lockedUntilMs && record.lockedUntilMs > nowMs) {
    return {
      unlocked: false,
      lockedOut: true,
      remainingLockoutMs: record.lockedUntilMs - nowMs,
      failedAttempts: record.failedAttempts,
    };
  }

  if (!isValidFourDigitPin(pin)) {
    return {
      unlocked: false,
      lockedOut: false,
      remainingLockoutMs: 0,
      failedAttempts: record.failedAttempts,
    };
  }

  const matched = await verifySecretHash(pin, record.salt, record.hash, {
    domain: `${LOCAL_PIN_DOMAIN}:${shopId}`,
    iterations: record.iterations,
  });

  if (matched) {
    if (record.failedAttempts > 0 || record.lockedUntilMs !== null) {
      const cleanRecord: StoredLocalPinRecord = {
        ...record,
        failedAttempts: 0,
        lockedUntilMs: null,
      };
      localStorage.setItem(pinStorageKey(shopId), JSON.stringify(cleanRecord));
    }
    return {
      unlocked: true,
      lockedOut: false,
      remainingLockoutMs: 0,
      failedAttempts: 0,
    };
  }

  const nextAttempts = record.failedAttempts + 1;
  const lockoutMs = calculateLocalScreenLockoutMs(nextAttempts);
  const lockedUntilMs = lockoutMs > 0 ? nowMs + lockoutMs : null;
  const updatedRecord: StoredLocalPinRecord = {
    ...record,
    failedAttempts: nextAttempts,
    lockedUntilMs,
  };
  localStorage.setItem(pinStorageKey(shopId), JSON.stringify(updatedRecord));

  return {
    unlocked: false,
    lockedOut: lockoutMs > 0,
    remainingLockoutMs: lockoutMs,
    failedAttempts: nextAttempts,
  };
}

export function clearLocalPinRecord(shopId: string): void {
  if (!shopId) return;
  localStorage.removeItem(pinStorageKey(shopId));
}

export function readScreenLockedState(): boolean {
  return localStorage.getItem(SCREEN_LOCKED_STORAGE_KEY) === '1';
}

export function persistScreenLockedState(locked: boolean): void {
  if (locked) {
    localStorage.setItem(SCREEN_LOCKED_STORAGE_KEY, '1');
  } else {
    localStorage.removeItem(SCREEN_LOCKED_STORAGE_KEY);
  }
}

/**
 * Runs a single WebCrypto PBKDF2-SHA256 derivation at `LOCAL_PBKDF2_ITERATIONS`
 * (or custom `iterations`) and returns elapsed wall-clock milliseconds.
 * Useful for verifying unlock latency on budget Android devices during staging.
 */
export async function measureLocalPbkdf2UnlockMs(
  iterations = LOCAL_PBKDF2_ITERATIONS
): Promise<{ iterations: number; elapsedMs: number }> {
  const salt = generateSaltHex();
  const start = performance.now();
  await deriveSecretHashHex('1234', salt, {
    domain: `${LOCAL_PIN_DOMAIN}:benchmark`,
    iterations,
  });
  const elapsedMs = Math.round((performance.now() - start) * 10) / 10;
  return { iterations, elapsedMs };
}
