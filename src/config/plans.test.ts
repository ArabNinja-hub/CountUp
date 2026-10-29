import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXPIRY_WARNING_DAYS,
  GRACE_PERIOD_DAYS,
  TRIAL_DURATION_DAYS,
  getSubscriptionInfo,
} from '../config/plans';

/**
 * All dates are built from a frozen "now" so the day maths is deterministic.
 * `NOW` is a fixed instant; helpers express offsets in whole days from it.
 */
const NOW = new Date('2026-06-15T12:00:00.000Z');

const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO string `days` away from NOW (negative = in the past). */
const fromNow = (days: number): string => new Date(NOW.getTime() + days * DAY_MS).toISOString();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getSubscriptionInfo — trial', () => {
  it('is on trial with the full period left on day zero', () => {
    const info = getSubscriptionInfo(fromNow(0));
    expect(info.status).toBe('trial');
    expect(info.daysRemaining).toBe(TRIAL_DURATION_DAYS);
    expect(info.canRecordSales).toBe(true);
    expect(info.isWarningPeriod).toBe(false);
  });

  it('counts down the days remaining during the trial', () => {
    const info = getSubscriptionInfo(fromNow(-10));
    expect(info.status).toBe('trial');
    expect(info.daysRemaining).toBe(TRIAL_DURATION_DAYS - 10);
    expect(info.canRecordSales).toBe(true);
  });

  it('warns during the last days before expiry', () => {
    const info = getSubscriptionInfo(fromNow(-(TRIAL_DURATION_DAYS - EXPIRY_WARNING_DAYS)));
    expect(info.status).toBe('trial');
    expect(info.daysRemaining).toBe(EXPIRY_WARNING_DAYS);
    expect(info.isWarningPeriod).toBe(true);
  });

  it('falls into the grace period once the expiry day passes', () => {
    const info = getSubscriptionInfo(fromNow(-(TRIAL_DURATION_DAYS + 1)));
    expect(info.status).toBe('grace');
    expect(info.daysRemaining).toBe(-1);
    expect(info.graceDaysRemaining).toBe(GRACE_PERIOD_DAYS - 1);
    expect(info.canRecordSales).toBe(true);
    expect(info.isWarningPeriod).toBe(false);
  });

  it('is expired after the grace period ends', () => {
    const info = getSubscriptionInfo(fromNow(-(TRIAL_DURATION_DAYS + GRACE_PERIOD_DAYS)));
    expect(info.status).toBe('expired');
    expect(info.graceDaysRemaining).toBe(0);
    expect(info.canRecordSales).toBe(false);
  });

  it('flags a trial status from the shop record as a trial', () => {
    const info = getSubscriptionInfo(fromNow(-5), fromNow(20), 'trial');
    expect(info.status).toBe('trial');
    expect(info.daysRemaining).toBe(20);
  });
});

describe('getSubscriptionInfo — active plan', () => {
  it('is active while the paid period is running', () => {
    const info = getSubscriptionInfo(fromNow(-40), fromNow(20), 'active');
    expect(info.status).toBe('active');
    expect(info.daysRemaining).toBe(20);
    expect(info.canRecordSales).toBe(true);
    expect(info.isWarningPeriod).toBe(false);
  });

  it('warns in the final days of a paid plan', () => {
    const info = getSubscriptionInfo(fromNow(-25), fromNow(EXPIRY_WARNING_DAYS), 'active');
    expect(info.status).toBe('active');
    expect(info.isWarningPeriod).toBe(true);
  });

  it('uses the provided expiry date rather than the trial window', () => {
    const expiry = fromNow(90);
    const info = getSubscriptionInfo(fromNow(-200), expiry, 'active');
    expect(info.status).toBe('active');
    expect(info.daysRemaining).toBe(90);
    expect(info.effectiveExpiry.toISOString()).toBe(expiry);
  });
});

describe('getSubscriptionInfo — edge days', () => {
  it('treats the exact expiry instant as grace, not active', () => {
    const info = getSubscriptionInfo(fromNow(-10), fromNow(0), 'active');
    expect(info.daysRemaining).toBe(0);
    expect(info.status).toBe('grace');
    expect(info.canRecordSales).toBe(true);
  });

  it('still counts one day left in the last millisecond before expiry', () => {
    const expiry = new Date(NOW.getTime() + 1).toISOString();
    const info = getSubscriptionInfo(fromNow(-10), expiry, 'active');
    expect(info.daysRemaining).toBe(1);
    expect(info.status).toBe('active');
  });

  it('keeps grace for the whole grace window and expires on its last instant', () => {
    const lastGraceDay = getSubscriptionInfo(
      fromNow(-10),
      fromNow(-(GRACE_PERIOD_DAYS - 1)),
      'active'
    );
    expect(lastGraceDay.status).toBe('grace');
    expect(lastGraceDay.graceDaysRemaining).toBe(1);

    const afterGrace = getSubscriptionInfo(fromNow(-10), fromNow(-GRACE_PERIOD_DAYS), 'active');
    expect(afterGrace.status).toBe('expired');
    expect(afterGrace.canRecordSales).toBe(false);
  });

  it('reports a large negative balance for long-dead shops without throwing', () => {
    const info = getSubscriptionInfo(fromNow(-400), fromNow(-300), 'active');
    expect(info.status).toBe('expired');
    expect(info.daysRemaining).toBe(-300);
    expect(Number.isFinite(info.graceDaysRemaining)).toBe(true);
  });

  it('defaults to a trial window when no expiry is supplied', () => {
    const info = getSubscriptionInfo(fromNow(-TRIAL_DURATION_DAYS + 5));
    expect(info.status).toBe('trial');
    expect(info.daysRemaining).toBe(5);
    expect(info.effectiveExpiry.getTime()).toBe(
      new Date(fromNow(-TRIAL_DURATION_DAYS + 5)).getTime() + TRIAL_DURATION_DAYS * DAY_MS
    );
  });
});

describe('getSubscriptionInfo — canRecordSales contract', () => {
  it.each([
    ['trial', fromNow(0), undefined, true],
    ['active', fromNow(10), 'active' as const, true],
    ['grace', fromNow(-1), 'active' as const, true],
    ['expired', fromNow(-10), 'active' as const, false],
  ])('%s canRecordSales=%s', (_label, expiry, status, expected) => {
    const info = getSubscriptionInfo(fromNow(-60), expiry, status);
    expect(info.canRecordSales).toBe(expected);
  });
});
