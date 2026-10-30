import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatKwacha,
  formatKwachaCompact,
  formatWhen,
  isToday,
  normalizeZambianPhone,
  parseInt0,
  parseMoney,
  sanitizeIntegerInput,
  sanitizeMoneyInput,
  sanitizePhoneInput,
} from './format';

describe('sanitizeMoneyInput', () => {
  it('keeps plain numbers untouched', () => {
    expect(sanitizeMoneyInput('25')).toBe('25');
    expect(sanitizeMoneyInput('0.5')).toBe('0.5');
  });

  it('removes letters, spaces and symbols', () => {
    expect(sanitizeMoneyInput('12a')).toBe('12');
    expect(sanitizeMoneyInput(' 1 2 ')).toBe('12');
    expect(sanitizeMoneyInput('-5')).toBe('5');
    expect(sanitizeMoneyInput('K25')).toBe('25');
  });

  it('keeps only the first decimal point', () => {
    expect(sanitizeMoneyInput('1.5.2')).toBe('1.52');
    expect(sanitizeMoneyInput('1..')).toBe('1.');
    expect(sanitizeMoneyInput('.5')).toBe('.5');
  });

  it('turns thousands separators into a single number', () => {
    expect(sanitizeMoneyInput('1,250')).toBe('1250');
    expect(sanitizeMoneyInput('1,250.75')).toBe('1250.75');
  });

  it('returns an empty string when nothing valid was typed', () => {
    expect(sanitizeMoneyInput('')).toBe('');
    expect(sanitizeMoneyInput('abc')).toBe('');
  });
});

describe('sanitizeIntegerInput', () => {
  it('keeps digits only', () => {
    expect(sanitizeIntegerInput('50')).toBe('50');
    expect(sanitizeIntegerInput('1x2')).toBe('12');
    expect(sanitizeIntegerInput('12.7')).toBe('127');
    expect(sanitizeIntegerInput('-3')).toBe('3');
    expect(sanitizeIntegerInput('abc')).toBe('');
  });
});

describe('sanitizePhoneInput', () => {
  it('strips spacing and punctuation from a Zambian number', () => {
    expect(sanitizePhoneInput('+260 962 838 581')).toBe('260962838581');
    expect(sanitizePhoneInput('0962 838 581')).toBe('0962838581');
  });

  it('is capped at 12 digits (260 + 9)', () => {
    expect(sanitizePhoneInput('26096283858199')).toBe('260962838581');
  });

  it('drops everything when no digits were typed', () => {
    expect(sanitizePhoneInput('abc')).toBe('');
  });
});

describe('normalizeZambianPhone', () => {
  it('treats the international and national formats as the same shop number', () => {
    expect(normalizeZambianPhone('+260 977 000 000')).toBe('0977000000');
    expect(normalizeZambianPhone('0977 000 000')).toBe('0977000000');
    expect(normalizeZambianPhone('26097')).toBe('26097');
  });
});

describe('parseMoney / parseInt0', () => {
  it('parses positive amounts', () => {
    expect(parseMoney('15.5')).toBe(15.5);
    expect(parseMoney('0.5')).toBe(0.5);
  });

  it('treats missing, zero and negative values as 0', () => {
    expect(parseMoney('')).toBe(0);
    expect(parseMoney('abc')).toBe(0);
    expect(parseMoney('0')).toBe(0);
    expect(parseMoney('-4')).toBe(0);
  });

  it('parses whole quantities and rejects junk', () => {
    expect(parseInt0('12')).toBe(12);
    expect(parseInt0('0')).toBe(0);
    expect(parseInt0('x')).toBe(0);
  });
});

describe('formatKwacha', () => {
  it('always shows two decimals with a K prefix', () => {
    expect(formatKwacha(0)).toBe('K 0.00');
    expect(formatKwacha(12.5)).toBe('K 12.50');
    expect(formatKwacha(1234.5)).toBe('K 1,234.50');
  });

  it('never prints NaN or Infinity', () => {
    expect(formatKwacha(Number.NaN)).toBe('K 0.00');
    expect(formatKwacha(Number.POSITIVE_INFINITY)).toBe('K 0.00');
  });
});

describe('formatKwachaCompact', () => {
  it('drops trailing zero cents', () => {
    expect(formatKwachaCompact(1250)).toBe('K 1,250');
    expect(formatKwachaCompact(12.5)).toBe('K 12.5');
    expect(formatKwachaCompact(Number.NaN)).toBe('K 0');
  });
});

describe('formatWhen / isToday', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('recognises today', () => {
    expect(isToday(new Date('2026-06-15T01:00:00.000Z').toISOString())).toBe(true);
    expect(isToday('2026-06-14T23:00:00.000Z')).toBe(false);
  });

  it('labels today and yesterday, and dates older entries', () => {
    expect(formatWhen(new Date('2026-06-15T09:30:00.000Z').toISOString())).toMatch(/^Today at /);
    expect(formatWhen(new Date('2026-06-14T09:30:00.000Z').toISOString())).toMatch(
      /^Yesterday at /
    );
    expect(formatWhen('2026-03-02T09:30:00.000Z')).toMatch(/2026/);
  });

  it('does not crash on an invalid date', () => {
    expect(formatWhen('not-a-date')).toBe('—');
    expect(isToday('not-a-date')).toBe(false);
  });
});
