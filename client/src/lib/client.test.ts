import { describe, expect, it } from 'vitest';
import { MARKETS, parseUnits, type OrderDto, type TradeDto } from '@pte/shared';
import {
  basisPoints,
  displayAsset,
  displayPrice,
  displayQty,
  percentDifference,
} from './format.ts';
import { initialMarketState, marketReducer, MAX_TRADES, mergeTrades } from './marketState.ts';
import { fractionOfMax, maxQuantity, previewOrder } from './orderForm.ts';
import { applyOrderUpdate, EMPTY_ORDERS, mergeOrders } from './orders.ts';

const BTC = MARKETS['BTC-USD'];
const cash = (value: string) => parseUnits(value, 10);
const price = (value: string) => parseUnits(value, 2);

function trade(id: number, market: TradeDto['market'] = 'BTC-USD'): TradeDto {
  return {
    id: String(id),
    market,
    price: '50000',
    quantity: '0.1',
    takerSide: 'buy',
    createdAt: '',
  };
}

function order(id: string, status: OrderDto['status'], updatedAt: string): OrderDto {
  return {
    id,
    market: 'BTC-USD',
    side: 'buy',
    type: 'limit',
    price: '50000',
    quantity: '1',
    filledQuantity: '0',
    status,
    cancelReason: status === 'cancelled' ? 'user' : null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
  };
}

describe('format', () => {
  it('formats API decimal strings for display', () => {
    expect(displayPrice('77394.1')).toBe('$77,394.10');
    expect(displayPrice(null)).toBe('—');
    expect(displayQty('0.015', 'BTC-USD')).toBe('0.01500');
    expect(displayAsset('USD', '99000.123456')).toBe('$99,000.12');
    expect(displayAsset('ETH', '1.5')).toBe('1.5000');
  });

  it('computes signed percentage differences', () => {
    expect(percentDifference(price('50050'), price('50000'))).toBe('+0.10%');
    expect(percentDifference(price('49500'), price('50000'))).toBe('−1.00%');
    expect(percentDifference(price('50000'), price('50000'))).toBe('0.00%');
    expect(percentDifference(1n, 0n)).toBe('—');
  });
});

describe('marketReducer', () => {
  it('ignores messages for other markets', () => {
    const state = initialMarketState('BTC-USD');
    expect(marketReducer(state, { type: 'trade', trade: trade(1, 'ETH-USD') })).toBe(state);
    expect(
      marketReducer(state, { type: 'book', book: { market: 'ETH-USD', bids: [], asks: [] } }),
    ).toBe(state);
  });

  it('keeps a live trade that arrived before the snapshot', () => {
    let state = initialMarketState('BTC-USD');
    state = marketReducer(state, { type: 'trade', trade: trade(5) });
    state = marketReducer(state, {
      type: 'trades',
      market: 'BTC-USD',
      trades: [trade(4), trade(3)],
    });
    expect(state.trades.map((t) => t.id)).toEqual(['5', '4', '3']);
  });

  it('dedupes and caps the trade list', () => {
    const many = Array.from({ length: 80 }, (_, i) => trade(i + 1));
    const merged = mergeTrades(many.slice(0, 40), many);
    expect(merged).toHaveLength(MAX_TRADES);
    expect(merged[0]?.id).toBe('80');
  });
});

describe('orders state', () => {
  it('moves orders between open and history as they change', () => {
    let state = applyOrderUpdate(EMPTY_ORDERS, order('1', 'open', '2026-01-01T00:00:01.000Z'));
    expect(state.open.map((o) => o.id)).toEqual(['1']);
    state = applyOrderUpdate(state, order('1', 'cancelled', '2026-01-01T00:00:02.000Z'));
    expect(state.open).toEqual([]);
    expect(state.history.map((o) => o.status)).toEqual(['cancelled']);
  });

  it('ignores stale updates that arrive late', () => {
    const fresh = applyOrderUpdate(EMPTY_ORDERS, order('1', 'filled', '2026-01-01T00:00:05.000Z'));
    const after = mergeOrders(fresh, [order('1', 'open', '2026-01-01T00:00:01.000Z')]);
    expect(after.open).toEqual([]);
    expect(after.history[0]?.status).toBe('filled');
  });

  it('sorts newest first by id', () => {
    const state = mergeOrders(EMPTY_ORDERS, [
      order('2', 'open', 'a'),
      order('10', 'open', 'a'),
      order('9', 'open', 'a'),
    ]);
    expect(state.open.map((o) => o.id)).toEqual(['10', '9', '2']);
  });
});

describe('order form', () => {
  it('computes max buy quantity from cash and price, floored to the step', () => {
    // $1,000 at $50,000 = 0.02 BTC
    expect(
      maxQuantity(BTC, { side: 'buy', type: 'limit' }, cash('1000'), price('50000'), null),
    ).toBe(parseUnits('0.02', 8));
    // $1,000 at $30,000 = 0.0333… → 0.03333
    expect(
      maxQuantity(BTC, { side: 'buy', type: 'limit' }, cash('1000'), price('30000'), null),
    ).toBe(parseUnits('0.03333', 8));
  });

  it('sizes market buys at the protection price so 100% is actually affordable', () => {
    const max = maxQuantity(
      BTC,
      { side: 'buy', type: 'market' },
      cash('1050'),
      null,
      price('50000'),
    );
    expect(max).toBe(parseUnits('0.02', 8)); // reserve at $52,500
  });

  it('uses coins owned for sells and handles missing prices', () => {
    expect(
      maxQuantity(BTC, { side: 'sell', type: 'limit' }, parseUnits('0.123456', 8), null, null),
    ).toBe(parseUnits('0.12345', 8));
    expect(maxQuantity(BTC, { side: 'buy', type: 'limit' }, cash('1000'), null, null)).toBe(0n);
  });

  it('turns a percentage into an input string', () => {
    expect(fractionOfMax(parseUnits('0.02', 8), 50, BTC.qtyStep)).toBe('0.01');
    expect(fractionOfMax(0n, 100, BTC.qtyStep)).toBe('');
  });

  it('previews totals and reserves, and reports the first problem', () => {
    const reference = price('50000');
    expect(
      previewOrder(BTC, { side: 'buy', type: 'limit', price: '50000', quantity: '0.1' }, reference),
    ).toEqual({ total: cash('5000'), reserve: cash('5000'), error: null });

    expect(
      previewOrder(BTC, { side: 'buy', type: 'market', price: '', quantity: '0.1' }, reference),
    ).toEqual({ total: cash('5000'), reserve: cash('5250'), error: null });

    expect(
      previewOrder(BTC, { side: 'buy', type: 'limit', price: '10', quantity: '0.1' }, reference)
        .error,
    ).toMatch(/within 10%/);

    expect(
      previewOrder(BTC, { side: 'buy', type: 'limit', price: '50000', quantity: '' }, reference)
        .error,
    ).toBe('Quantity is required');
  });
});

describe('basisPoints', () => {
  it('truncates toward zero so tiny gaps read as neutral', () => {
    expect(basisPoints(price('77410.35'), price('77410.36'))).toBe(0n);
    expect(basisPoints(price('50050'), price('50000'))).toBe(10n);
    expect(basisPoints(price('49950'), price('50000'))).toBe(-10n);
  });
});
