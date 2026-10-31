import { describe, expect, it } from 'vitest';
import { formatCash, formatPrice, formatQty } from './format.ts';
import {
  CASH_DECIMALS,
  countFractionDigits,
  countWholeDigits,
  formatUnits,
  notional,
  parseUnits,
  PRICE_DECIMALS,
  QTY_DECIMALS,
  scaleByBps,
} from './money.ts';

describe('parseUnits', () => {
  it.each([
    ['0', 8, 0n],
    ['1', 8, 100_000_000n],
    ['0.015', 8, 1_500_000n],
    ['0.00000001', 8, 1n],
    ['77394.14', 2, 7_739_414n],
    ['007.50', 2, 750n],
    ['  12.5  ', 2, 1_250n],
    ['5', 0, 5n],
  ])('parses %s with %i decimals', (input, decimals, expected) => {
    expect(parseUnits(input, decimals)).toBe(expected);
  });

  it('rejects extra precision in strict mode', () => {
    expect(() => parseUnits('0.123', 2)).toThrow(RangeError);
  });

  it('truncates extra precision in truncate mode', () => {
    expect(parseUnits('77394.149', 2, 'truncate')).toBe(7_739_414n);
  });

  it.each(['', '-1', '1e5', 'abc', '.5', '5.', '1,000', 'NaN'])('rejects %j', (input) => {
    expect(() => parseUnits(input, 8)).toThrow(RangeError);
  });
});

describe('formatUnits', () => {
  it('is exact and trims trailing zeros by default', () => {
    expect(formatUnits(1_500_000n, 8)).toBe('0.015');
    expect(formatUnits(100_000_000n, 8)).toBe('1');
    expect(formatUnits(0n, 8)).toBe('0');
    expect(formatUnits(1n, 8)).toBe('0.00000001');
  });

  it('round-trips with parseUnits', () => {
    for (const value of ['0', '1', '0.5', '123456.789', '0.00000001', '99999999.99999999']) {
      expect(formatUnits(parseUnits(value, 8), 8)).toBe(value);
    }
  });

  it('rounds half away from zero when limiting fraction digits', () => {
    expect(formatUnits(1_234_500n, 8, { maxFraction: 4 })).toBe('0.0123');
    expect(formatUnits(1_235_000n, 8, { maxFraction: 4 })).toBe('0.0124');
    expect(formatUnits(-1_235_000n, 8, { maxFraction: 4 })).toBe('-0.0124');
    expect(formatUnits(99_999_999n, 8, { maxFraction: 2 })).toBe('1');
  });

  it('pads to minFraction and groups thousands', () => {
    expect(formatUnits(123_456_789n, 2, { minFraction: 2, grouping: true })).toBe('1,234,567.89');
    expect(formatUnits(100n, 2, { minFraction: 2 })).toBe('1.00');
  });

  it('does not print negative zero after rounding', () => {
    expect(formatUnits(-1n, 8, { maxFraction: 2 })).toBe('0');
  });
});

describe('notional', () => {
  it('multiplies price units by quantity units into exact cash units', () => {
    const price = parseUnits('77394.14', PRICE_DECIMALS);
    const quantity = parseUnits('0.015', QTY_DECIMALS);
    expect(formatUnits(notional(price, quantity), CASH_DECIMALS)).toBe('1160.9121');
  });

  it('is exact where floats are not', () => {
    const cost = notional(parseUnits('0.1', PRICE_DECIMALS), parseUnits('3', QTY_DECIMALS));
    expect(formatUnits(cost, CASH_DECIMALS)).toBe('0.3');
  });
});

describe('scaleByBps', () => {
  it('scales up and down with explicit rounding', () => {
    expect(scaleByBps(10_000n, 11_000, 'floor')).toBe(11_000n);
    expect(scaleByBps(10_001n, 11_000, 'floor')).toBe(11_001n);
    expect(scaleByBps(10_005n, 9_000, 'floor')).toBe(9_004n);
    expect(scaleByBps(10_005n, 9_000, 'ceil')).toBe(9_005n);
    expect(scaleByBps(10_000n, 9_000, 'ceil')).toBe(9_000n);
  });
});

describe('digit counters', () => {
  it('counts fraction and whole digits', () => {
    expect(countFractionDigits('1.234')).toBe(3);
    expect(countFractionDigits('12')).toBe(0);
    expect(countWholeDigits('000123.4')).toBe(3);
    expect(countWholeDigits('0.5')).toBe(0);
  });
});

describe('display formatters', () => {
  it('formats prices, cash and quantities', () => {
    expect(formatPrice(7_739_414n)).toBe('$77,394.14');
    expect(formatPrice(500n)).toBe('$5.00');
    expect(formatCash(parseUnits('100000', CASH_DECIMALS))).toBe('$100,000.00');
    expect(formatCash(parseUnits('1160.9121', CASH_DECIMALS))).toBe('$1,160.91');
    expect(formatCash(-parseUnits('5', CASH_DECIMALS))).toBe('-$5.00');
    expect(formatQty(1_500_000n, 5)).toBe('0.01500');
  });
});
