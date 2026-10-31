/**
 * Every amount in the system is an integer number of "units", held in a BigInt.
 *
 * Floats can't be trusted with money: 0.1 + 0.2 === 0.30000000000000004 in JS,
 * and an exchange has to reconcile to the last unit. So instead of storing
 * "0.015 BTC" we store 1_500_000 quantity units, and convert to/from decimal
 * strings only at the edges (API input, display).
 *
 *   quantity  1 unit = 0.00000001 coin (a "satoshi")      QTY_DECIMALS   = 8
 *   price     1 unit = $0.01 per whole coin               PRICE_DECIMALS = 2
 *   cash      1 unit = $0.0000000001                      CASH_DECIMALS  = 10
 *
 * Cash has PRICE_DECIMALS + QTY_DECIMALS decimals on purpose: then
 * price units × quantity units = cash units, exactly, with no rounding ever.
 */
export const QTY_DECIMALS = 8;
export const PRICE_DECIMALS = 2;
export const CASH_DECIMALS = PRICE_DECIMALS + QTY_DECIMALS;

const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;
const BPS_DENOMINATOR = 10_000n;

export function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

export function isDecimalString(value: string): boolean {
  return DECIMAL_PATTERN.test(value);
}

export function countFractionDigits(value: string): number {
  const dot = value.indexOf('.');
  return dot === -1 ? 0 : value.length - dot - 1;
}

export function countWholeDigits(value: string): number {
  const dot = value.indexOf('.');
  const whole = dot === -1 ? value : value.slice(0, dot);
  return whole.replace(/^0+/, '').length;
}

/**
 * "12.345" with 8 decimals -> 1_234_500_000n.
 * `strict` rejects extra precision; `truncate` drops it (used for external
 * price feeds that may send more decimals than we track).
 */
export function parseUnits(
  value: string,
  decimals: number,
  mode: 'strict' | 'truncate' = 'strict',
): bigint {
  const trimmed = value.trim();
  if (!isDecimalString(trimmed)) {
    throw new RangeError(`Not a non-negative decimal number: "${value}"`);
  }
  const [whole = '0', fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals && mode === 'strict') {
    throw new RangeError(`"${value}" has more than ${decimals} decimal places`);
  }
  const paddedFraction = fraction.slice(0, decimals).padEnd(decimals, '0');
  return BigInt(whole) * pow10(decimals) + BigInt(paddedFraction === '' ? '0' : paddedFraction);
}

export interface FormatOptions {
  /** Round (half away from zero) to at most this many fraction digits. Default: all of them. */
  maxFraction?: number;
  /** Pad with zeros to at least this many fraction digits. Default: 0. */
  minFraction?: number;
  /** Insert thousands separators ("1,234.5"). Default: false. */
  grouping?: boolean;
}

/**
 * 1_234_500_000n with 8 decimals -> "12.345". Exact by default (no rounding,
 * trailing zeros trimmed), which is what the API sends over the wire.
 */
export function formatUnits(units: bigint, decimals: number, options: FormatOptions = {}): string {
  const { maxFraction = decimals, minFraction = 0, grouping = false } = options;
  const negative = units < 0n;
  let magnitude = negative ? -units : units;
  let scale = decimals;

  if (maxFraction < decimals) {
    const factor = pow10(decimals - maxFraction);
    const remainder = magnitude % factor;
    magnitude = magnitude / factor + (remainder * 2n >= factor ? 1n : 0n);
    scale = maxFraction;
  }

  const divisor = pow10(scale);
  const whole = (magnitude / divisor).toString();
  let fraction = scale > 0 ? (magnitude % divisor).toString().padStart(scale, '0') : '';
  fraction = fraction.replace(/0+$/, '');
  if (fraction.length < minFraction) fraction = fraction.padEnd(minFraction, '0');

  const groupedWhole = grouping ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : whole;
  const isZero = magnitude === 0n;
  const sign = negative && !isZero ? '-' : '';
  return fraction ? `${sign}${groupedWhole}.${fraction}` : `${sign}${groupedWhole}`;
}

/** price units × quantity units = cash units (exact). */
export function notional(price: bigint, quantity: bigint): bigint {
  return price * quantity;
}

/**
 * Multiply a non-negative value by `bps / 10_000` with explicit rounding.
 * 10_500 bps = ×1.05, 9_500 bps = ×0.95.
 */
export function scaleByBps(value: bigint, bps: number, rounding: 'floor' | 'ceil'): bigint {
  const numerator = value * BigInt(bps);
  const quotient = numerator / BPS_DENOMINATOR;
  const hasRemainder = numerator % BPS_DENOMINATOR !== 0n;
  return rounding === 'ceil' && hasRemainder ? quotient + 1n : quotient;
}

export function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
