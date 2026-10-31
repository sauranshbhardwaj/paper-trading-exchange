import { describe, expect, it } from 'vitest';
import { MARKETS } from './markets.ts';
import { parseUnits, PRICE_DECIMALS, QTY_DECIMALS, CASH_DECIMALS } from './money.ts';
import {
  holdAmountFor,
  marketProtectionPrice,
  OrderRuleError,
  priceBand,
  resolveOrder,
  type OrderRequest,
} from './orderRules.ts';

const BTC = MARKETS['BTC-USD'];
const price = (value: string) => parseUnits(value, PRICE_DECIMALS);
const qty = (value: string) => parseUnits(value, QTY_DECIMALS);
const cash = (value: string) => parseUnits(value, CASH_DECIMALS);
const REFERENCE = price('50000');

function limit(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return {
    market: 'BTC-USD',
    side: 'buy',
    type: 'limit',
    price: price('50000'),
    quantity: qty('0.01'),
    ...overrides,
  };
}

function expectRuleError(fn: () => unknown, code: OrderRuleError['code']) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(OrderRuleError);
    expect((error as OrderRuleError).code).toBe(code);
    return;
  }
  throw new Error(`Expected OrderRuleError ${code}`);
}

describe('priceBand', () => {
  it('is ±10% of the reference by default', () => {
    expect(priceBand(REFERENCE)).toEqual({ min: price('45000'), max: price('55000') });
  });

  it('rounds inward so the band never exceeds the limit', () => {
    const band = priceBand(10_005n);
    expect(band.min).toBe(9_005n); // 9004.5 rounded up
    expect(band.max).toBe(11_005n); // 11005.5 rounded down
  });
});

describe('marketProtectionPrice', () => {
  it('is +5% for buys and -5% for sells', () => {
    expect(marketProtectionPrice('buy', REFERENCE)).toBe(price('52500'));
    expect(marketProtectionPrice('sell', REFERENCE)).toBe(price('47500'));
  });
});

describe('holdAmountFor', () => {
  it('locks cash for buys and coins for sells', () => {
    expect(holdAmountFor('buy', price('50000'), qty('0.01'))).toBe(cash('500'));
    expect(holdAmountFor('sell', price('50000'), qty('0.01'))).toBe(qty('0.01'));
  });
});

describe('resolveOrder', () => {
  it('resolves a limit buy to a GTC order holding cash', () => {
    expect(resolveOrder(BTC, limit(), REFERENCE)).toEqual({
      limitPrice: price('50000'),
      timeInForce: 'GTC',
      holdAsset: 'USD',
      holdAmount: cash('500'),
    });
  });

  it('resolves a limit sell to hold coins', () => {
    const resolved = resolveOrder(BTC, limit({ side: 'sell' }), REFERENCE);
    expect(resolved.holdAsset).toBe('BTC');
    expect(resolved.holdAmount).toBe(qty('0.01'));
  });

  it('resolves a market buy to an IOC order capped at the protection price', () => {
    const resolved = resolveOrder(
      BTC,
      { market: 'BTC-USD', side: 'buy', type: 'market', quantity: qty('0.01') },
      REFERENCE,
    );
    expect(resolved).toEqual({
      limitPrice: price('52500'),
      timeInForce: 'IOC',
      holdAsset: 'USD',
      holdAmount: cash('525'),
    });
  });

  it('accepts prices exactly on the band edges', () => {
    expect(() => resolveOrder(BTC, limit({ price: price('45000') }), REFERENCE)).not.toThrow();
    expect(() => resolveOrder(BTC, limit({ price: price('55000') }), REFERENCE)).not.toThrow();
  });

  it('rejects prices just outside the band', () => {
    expectRuleError(
      () => resolveOrder(BTC, limit({ price: price('44999.99') }), REFERENCE),
      'PRICE_OUT_OF_BAND',
    );
    expectRuleError(
      () => resolveOrder(BTC, limit({ price: price('55000.01') }), REFERENCE),
      'PRICE_OUT_OF_BAND',
    );
  });

  it('rejects quantities that are not a multiple of the step', () => {
    expectRuleError(
      () => resolveOrder(BTC, limit({ quantity: qty('0.000015') }), REFERENCE),
      'INVALID_QUANTITY',
    );
    expectRuleError(
      () => resolveOrder(BTC, limit({ quantity: 0n }), REFERENCE),
      'INVALID_QUANTITY',
    );
  });

  it('rejects limit orders without a positive price', () => {
    expectRuleError(
      () => resolveOrder(BTC, limit({ price: undefined }), REFERENCE),
      'INVALID_PRICE',
    );
    expectRuleError(() => resolveOrder(BTC, limit({ price: 0n }), REFERENCE), 'INVALID_PRICE');
  });

  it('rejects orders worth less than the minimum notional', () => {
    // 0.00001 BTC at $50,000 = $0.50 < $1
    expectRuleError(
      () => resolveOrder(BTC, limit({ quantity: qty('0.00001') }), REFERENCE),
      'BELOW_MIN_NOTIONAL',
    );
    // 0.00002 BTC at $50,000 = $1.00 — exactly the minimum is fine
    expect(() => resolveOrder(BTC, limit({ quantity: qty('0.00002') }), REFERENCE)).not.toThrow();
  });

  it('pauses trading when there is no reference price', () => {
    expectRuleError(() => resolveOrder(BTC, limit(), null), 'MARKET_DATA_UNAVAILABLE');
  });

  it('gives users a readable message', () => {
    try {
      resolveOrder(BTC, limit({ price: price('60000') }), REFERENCE);
    } catch (error) {
      expect((error as Error).message).toBe(
        'Price must be within 10% of the live price ($45,000.00 – $55,000.00)',
      );
    }
  });
});
