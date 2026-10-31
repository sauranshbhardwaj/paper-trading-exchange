import { describe, expect, it } from 'vitest';
import { ASSETS, MARKETS, type Asset } from '@pte/shared';
import { OrderBook, type IncomingOrder } from './orderBook.ts';
import {
  BalanceDeltas,
  computeCancellation,
  computeSettlement,
  takerFinalState,
  type Settlement,
  type TakerOrder,
} from './settlement.ts';

const BTC = MARKETS['BTC-USD'];

function totalChange(settlement: Settlement, asset: Asset): bigint {
  return settlement.deltas
    .list()
    .filter((delta) => delta.asset === asset)
    .reduce((sum, delta) => sum + delta.available + delta.held, 0n);
}

function run(
  makers: Array<Omit<IncomingOrder, 'timeInForce'>>,
  taker: TakerOrder & { timeInForce?: IncomingOrder['timeInForce'] },
): Settlement {
  const book = new OrderBook('BTC-USD');
  for (const maker of makers) book.add(maker);
  const result = book.match({
    id: taker.id,
    userId: taker.userId,
    side: taker.side,
    price: taker.limitPrice,
    remaining: taker.quantity,
    timeInForce: taker.timeInForce ?? 'GTC',
  });
  return computeSettlement(BTC, taker, result);
}

describe('BalanceDeltas', () => {
  it('accumulates changes per user and asset', () => {
    const deltas = new BalanceDeltas();
    deltas.hold('1', 'USD', 100n);
    deltas.release('1', 'USD', 30n);
    deltas.add('1', 'BTC', { available: 5n });
    expect(deltas.get('1', 'USD')).toEqual({
      userId: '1',
      asset: 'USD',
      available: -70n,
      held: 70n,
    });
    expect(deltas.get('1', 'BTC')).toEqual({ userId: '1', asset: 'BTC', available: 5n, held: 0n });
  });

  it('lists entries sorted numerically by user id, then asset', () => {
    const deltas = new BalanceDeltas();
    deltas.add('10', 'USD', { available: 1n });
    deltas.add('9', 'USD', { available: 1n });
    deltas.add('9', 'BTC', { available: 1n });
    expect(deltas.keys()).toEqual([
      { userId: '9', asset: 'BTC' },
      { userId: '9', asset: 'USD' },
      { userId: '10', asset: 'USD' },
    ]);
    expect(deltas.userIds()).toEqual(['9', '10']);
  });
});

describe('computeSettlement', () => {
  it('a resting buy only locks cash', () => {
    const settlement = run([], {
      id: 't',
      userId: '1',
      side: 'buy',
      limitPrice: 100n,
      quantity: 5n,
    });
    expect(settlement.deltas.list()).toEqual([
      { userId: '1', asset: 'USD', available: -500n, held: 500n },
    ]);
    expect(settlement).toMatchObject({
      takerFilled: 0n,
      takerStatus: 'open',
      takerCancelReason: null,
    });
  });

  it('taker buyer pays the maker price and gets the difference back', () => {
    const settlement = run([{ id: 'm', userId: '2', side: 'sell', price: 100n, remaining: 5n }], {
      id: 't',
      userId: '1',
      side: 'buy',
      limitPrice: 110n,
      quantity: 5n,
    });
    // Buyer locked 550, paid 500: net -500 cash, +5 BTC, nothing left held.
    expect(settlement.deltas.get('1', 'USD')).toMatchObject({ available: -500n, held: 0n });
    expect(settlement.deltas.get('1', 'BTC')).toMatchObject({ available: 5n, held: 0n });
    // Seller's held coins leave, cash arrives.
    expect(settlement.deltas.get('2', 'BTC')).toMatchObject({ available: 0n, held: -5n });
    expect(settlement.deltas.get('2', 'USD')).toMatchObject({ available: 500n, held: 0n });
    expect(settlement.trades).toEqual([
      {
        makerOrderId: 'm',
        takerOrderId: 't',
        buyerId: '1',
        sellerId: '2',
        price: 100n,
        quantity: 5n,
        takerSide: 'buy',
      },
    ]);
    expect(settlement.takerStatus).toBe('filled');
  });

  it('taker seller hitting a resting bid: maker buyer pays exactly its limit', () => {
    const settlement = run([{ id: 'm', userId: '2', side: 'buy', price: 100n, remaining: 5n }], {
      id: 't',
      userId: '1',
      side: 'sell',
      limitPrice: 90n,
      quantity: 3n,
    });
    expect(settlement.deltas.get('2', 'USD')).toMatchObject({ available: 0n, held: -300n });
    expect(settlement.deltas.get('2', 'BTC')).toMatchObject({ available: 3n });
    expect(settlement.deltas.get('1', 'BTC')).toMatchObject({ available: -3n, held: 0n });
    expect(settlement.deltas.get('1', 'USD')).toMatchObject({ available: 300n });
    expect(settlement.makerUpdates).toEqual([
      { orderId: 'm', userId: '2', filled: 3n, remainingAfter: 2n },
    ]);
  });

  it('a partially filled resting order keeps exactly the hold for its remainder', () => {
    const settlement = run([{ id: 'm', userId: '2', side: 'sell', price: 100n, remaining: 2n }], {
      id: 't',
      userId: '1',
      side: 'buy',
      limitPrice: 105n,
      quantity: 5n,
    });
    // Remaining 3 rest at 105 → held must be 315.
    expect(settlement.deltas.get('1', 'USD')).toMatchObject({ held: 315n, available: -515n });
    expect(settlement).toMatchObject({ takerFilled: 2n, takerStatus: 'open' });
  });

  it('an IOC remainder releases its hold', () => {
    const settlement = run([{ id: 'm', userId: '2', side: 'sell', price: 100n, remaining: 2n }], {
      id: 't',
      userId: '1',
      side: 'buy',
      limitPrice: 105n,
      quantity: 5n,
      timeInForce: 'IOC',
    });
    expect(settlement.deltas.get('1', 'USD')).toMatchObject({ held: 0n, available: -200n });
    expect(settlement).toMatchObject({
      takerFilled: 2n,
      takerStatus: 'cancelled',
      takerCancelReason: 'unfilled_remainder',
    });
  });

  it('self-trade prevention releases the hold and records the reason', () => {
    const settlement = run([{ id: 'm', userId: '1', side: 'sell', price: 100n, remaining: 2n }], {
      id: 't',
      userId: '1',
      side: 'buy',
      limitPrice: 100n,
      quantity: 5n,
    });
    expect(settlement.deltas.get('1', 'USD')).toMatchObject({ held: 0n, available: 0n });
    expect(settlement.trades).toEqual([]);
    expect(settlement.takerCancelReason).toBe('self_trade_prevention');
  });

  it('conserves every asset across a multi-level sweep', () => {
    const settlement = run(
      [
        { id: 'm1', userId: '2', side: 'sell', price: 100n, remaining: 2n },
        { id: 'm2', userId: '3', side: 'sell', price: 101n, remaining: 2n },
        { id: 'm3', userId: '4', side: 'sell', price: 103n, remaining: 2n },
      ],
      { id: 't', userId: '1', side: 'buy', limitPrice: 102n, quantity: 7n },
    );
    for (const asset of ASSETS) expect(totalChange(settlement, asset)).toBe(0n);
    expect(settlement.takerFilled).toBe(4n);
    // 3 left resting at 102.
    expect(settlement.deltas.get('1', 'USD')?.held).toBe(306n);
  });
});

describe('takerFinalState', () => {
  it('maps every outcome', () => {
    expect(takerFinalState('filled')).toEqual({ status: 'filled', cancelReason: null });
    expect(takerFinalState('resting')).toEqual({ status: 'open', cancelReason: null });
    expect(takerFinalState('expired')).toEqual({
      status: 'cancelled',
      cancelReason: 'unfilled_remainder',
    });
    expect(takerFinalState('self_trade_prevented')).toEqual({
      status: 'cancelled',
      cancelReason: 'self_trade_prevention',
    });
  });
});

describe('computeCancellation', () => {
  it('releases cash for a buy at its limit price', () => {
    const deltas = computeCancellation(BTC, {
      userId: '1',
      side: 'buy',
      limitPrice: 100n,
      remaining: 3n,
    });
    expect(deltas.list()).toEqual([{ userId: '1', asset: 'USD', available: 300n, held: -300n }]);
  });

  it('releases coins for a sell', () => {
    const deltas = computeCancellation(BTC, {
      userId: '1',
      side: 'sell',
      limitPrice: 100n,
      remaining: 3n,
    });
    expect(deltas.list()).toEqual([{ userId: '1', asset: 'BTC', available: 3n, held: -3n }]);
  });
});
