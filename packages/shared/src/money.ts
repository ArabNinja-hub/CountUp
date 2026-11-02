/** Money is stored exclusively as integer ngwee. PROVISIONAL ADR-10 — NOT APPROVED. */
export const NGWEE_PER_KWACHA = 100;

export function kwachaToNgwee(kwacha: number): number {
  if (!Number.isFinite(kwacha)) {
    throw new TypeError('kwacha must be a finite number');
  }
  const ngwee = Math.round(kwacha * NGWEE_PER_KWACHA);
  if (!Number.isSafeInteger(ngwee)) {
    throw new RangeError('kwacha value is too large for safe integer ngwee');
  }
  return ngwee;
}

export function formatNgwee(ngwee: number): string {
  if (!Number.isSafeInteger(ngwee)) {
    throw new TypeError('ngwee must be a safe integer');
  }
  const sign = ngwee < 0 ? '-' : '';
  const absolute = Math.abs(ngwee);
  return `${sign}K${Math.floor(absolute / NGWEE_PER_KWACHA)}.${String(absolute % NGWEE_PER_KWACHA).padStart(2, '0')}`;
}
