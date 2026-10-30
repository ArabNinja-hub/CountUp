/** Exact money arithmetic at the edges of CountUp's existing Kwacha schema.
 * ShopBook used integer ngwee; CountUp records continue to use Kwacha so old
 * Firestore documents need no destructive migration. Calculations use ngwee.
 */
export function parseKwachaToNgwee(raw: string, allowZero = false): number {
  const cleaned = raw.trim().replace(/^K\s*/i, '').replace(/,/g, '');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) throw new Error('Enter a valid amount with at most two decimal places.');
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(2, '0'));
  const result = whole * 100 + fraction;
  if (!Number.isSafeInteger(result) || result > 1_000_000_000 || (!allowZero && result === 0)) {
    throw new Error(
      allowZero
        ? 'Enter an amount between K 0 and K 10,000,000.'
        : 'Enter an amount greater than K 0 and no more than K 10,000,000.'
    );
  }
  return result;
}

/** Convert a legacy Kwacha number to integer ngwee, rejecting fractions of a ngwee. */
export function toNgwee(amount: number): number {
  const cents = Math.round(amount * 100);
  if (
    !Number.isFinite(amount) ||
    !Number.isSafeInteger(cents) ||
    Math.abs(amount * 100 - cents) > 0.000001
  ) {
    throw new Error('Amount must be a valid Kwacha value with at most two decimal places.');
  }
  return cents;
}

export const fromNgwee = (amount: number): number => amount / 100;

export function addKwacha(...amounts: number[]): number {
  const result = amounts.reduce((sum, amount) => sum + toNgwee(amount), 0);
  if (!Number.isSafeInteger(result)) throw new Error('The total is too large.');
  return fromNgwee(result);
}

export function multiplyKwacha(amount: number, quantity: number): number {
  if (!Number.isSafeInteger(quantity) || quantity < 0)
    throw new Error('Quantity must be a whole number.');
  const result = toNgwee(amount) * quantity;
  if (!Number.isSafeInteger(result)) throw new Error('The total is too large.');
  return fromNgwee(result);
}

export function localDateKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
