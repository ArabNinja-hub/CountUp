// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearLocalPinRecord,
  getLocalLockoutRemainingMs,
  hasLocalPinRecord,
  persistScreenLockedState,
  readLocalPinRecord,
  readScreenLockedState,
  saveLocalPinRecord,
  verifyLocalPin,
} from './pinLock';

describe('pinLock (offline WebCrypto PBKDF2 screen lock)', () => {
  const shopA = '11111111-1111-4111-8111-111111111111';
  const shopB = '22222222-2222-4222-8222-222222222222';
  const fastIterations = 1_000;

  beforeEach(() => {
    localStorage.clear();
  });

  it('stores a salted PBKDF2 hash with zero plain-text PIN in localStorage', async () => {
    await saveLocalPinRecord(shopA, '7391', { iterations: fastIterations });

    expect(hasLocalPinRecord(shopA)).toBe(true);
    const record = readLocalPinRecord(shopA);
    expect(record).not.toBeNull();
    expect(record?.version).toBe(2);
    expect(record?.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(record?.hash).toMatch(/^[0-9a-f]{64}$/);

    const serializedStorage = JSON.stringify(
      Object.fromEntries(
        Array.from({ length: localStorage.length }, (_, idx) => {
          const key = localStorage.key(idx)!;
          return [key, localStorage.getItem(key)];
        })
      )
    );
    expect(serializedStorage).not.toContain('7391');

    const ok = await verifyLocalPin(shopA, '7391');
    expect(ok.unlocked).toBe(true);
    expect(ok.lockedOut).toBe(false);
    expect(ok.failedAttempts).toBe(0);
  });

  it('binds PBKDF2 derivation to shopId so copying a record across shops fails', async () => {
    await saveLocalPinRecord(shopA, '1234', { iterations: fastIterations });
    const recordA = readLocalPinRecord(shopA)!;

    // Tamper: copy Shop A's salt + hash under Shop B's storage key
    localStorage.setItem(
      `countup_pin_lock_v2:${shopB}`,
      JSON.stringify({ ...recordA, shopId: shopB })
    );

    const verifyOnB = await verifyLocalPin(shopB, '1234');
    expect(verifyOnB.unlocked).toBe(false);
  });

  it('enforces escalating local lockout delays (30s, 2m, 10m, 30m) and resets after cooldown', async () => {
    await saveLocalPinRecord(shopA, '2468', { iterations: fastIterations });
    let now = 1_700_000_000_000;

    // Attempts 1-4: wrong PIN allowed without cooldown
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const res = await verifyLocalPin(shopA, '0000', now);
      expect(res.unlocked).toBe(false);
      expect(res.lockedOut).toBe(false);
      expect(res.failedAttempts).toBe(attempt);
    }

    // Attempt 5: 30s lockout
    const fifth = await verifyLocalPin(shopA, '0000', now);
    expect(fifth.lockedOut).toBe(true);
    expect(fifth.remainingLockoutMs).toBe(30_000);
    expect(getLocalLockoutRemainingMs(shopA, now + 10_000)).toBe(20_000);

    // Correct PIN during active cooldown must still be rejected
    const duringCooldown = await verifyLocalPin(shopA, '2468', now + 15_000);
    expect(duringCooldown.unlocked).toBe(false);
    expect(duringCooldown.lockedOut).toBe(true);

    // Advance past 30s cooldown -> Attempt 6 triggers 2m (120_000ms)
    now += 31_000;
    const sixth = await verifyLocalPin(shopA, '0000', now);
    expect(sixth.lockedOut).toBe(true);
    expect(sixth.remainingLockoutMs).toBe(120_000);

    // Advance past 2m cooldown -> Attempt 7 triggers 10m (600_000ms)
    now += 121_000;
    const seventh = await verifyLocalPin(shopA, '0000', now);
    expect(seventh.lockedOut).toBe(true);
    expect(seventh.remainingLockoutMs).toBe(600_000);

    // Advance past 10m cooldown -> Attempt 8 triggers 30m (1_800_000ms)
    now += 601_000;
    const eighth = await verifyLocalPin(shopA, '0000', now);
    expect(eighth.lockedOut).toBe(true);
    expect(eighth.remainingLockoutMs).toBe(1_800_000);

    // Advance past 30m cooldown -> Correct PIN unlocks and resets counters
    now += 1_801_000;
    const unlocked = await verifyLocalPin(shopA, '2468', now);
    expect(unlocked.unlocked).toBe(true);
    expect(unlocked.lockedOut).toBe(false);
    expect(unlocked.failedAttempts).toBe(0);
    expect(readLocalPinRecord(shopA)?.lockedUntilMs).toBeNull();
  });

  it('persists and clears screen lock and PIN storage cleanly', async () => {
    await saveLocalPinRecord(shopA, '9876', { iterations: fastIterations });
    persistScreenLockedState(true);
    expect(readScreenLockedState()).toBe(true);

    persistScreenLockedState(false);
    expect(readScreenLockedState()).toBe(false);

    clearLocalPinRecord(shopA);
    expect(hasLocalPinRecord(shopA)).toBe(false);
  });
});
