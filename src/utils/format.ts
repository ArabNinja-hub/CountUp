/**
 * Formatting + parsing helpers shared by every screen.
 *
 * The point is that the shopkeeper sees the same money format everywhere and that
 * every input field accepts the same things (digits, one decimal point, no letters).
 */

/** Short, consistent money label: `K 1,250.00`. */
export function formatKwacha(amount: number): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  return `K ${safe.toLocaleString('en-ZM', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Compact money label for tight tiles: `K 1,250` when there are no cents. */
export function formatKwachaCompact(amount: number): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  return `K ${safe.toLocaleString('en-ZM', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Keep only what can be part of a money value: digits and a single decimal point.
 * Typing "1.5.2" or "12a" can never leave the field, so no invalid price is saved.
 */
export function sanitizeMoneyInput(raw: string): string {
  let cleaned = raw.replace(/[^\d.]/g, '');
  const firstDot = cleaned.indexOf('.');
  if (firstDot !== -1) {
    cleaned = `${cleaned.slice(0, firstDot + 1)}${cleaned.slice(firstDot + 1).replace(/\./g, '')}`;
  }
  return cleaned;
}

/** Whole, non-negative quantity string (digits only). */
export function sanitizeIntegerInput(raw: string): string {
  return raw.replace(/[^\d]/g, '');
}

/** Zambian phone: digits only, max 12 (260 + 9) so pasted "+260 97…" still works. */
export function sanitizePhoneInput(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 12);
}

export function parseMoney(raw: string): number {
  const value = parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function parseInt0(raw: string): number {
  const value = parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** `Today at 14:05`, `Yesterday at 09:12`, or `12 Aug 2026`. */
export function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = date.toLocaleTimeString('en-ZM', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Today at ${time}`;
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday at ${time}`;
  return date.toLocaleDateString('en-ZM', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** True when the ISO timestamp falls on the current calendar day. */
export function isToday(iso: string): boolean {
  const date = new Date(iso);
  return !Number.isNaN(date.getTime()) && date.toDateString() === new Date().toDateString();
}
