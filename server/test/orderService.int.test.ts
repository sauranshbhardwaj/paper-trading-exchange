import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { MarketSymbol, OrderDto } from '@pte/shared';
import { OrderService } from '../src/trading/orderService.ts';
import { AppError } from '../src/errors.ts';
import {
  balancesOf,
  createTestContext,
  createTrader,
  expectAllInvariants,
  expectBookMatchesDatabase,
  expectHeldMatchesOpenOrders,
  limitOrder,
  marketOrder,
  price,
  resetDatabase,
  totalSupply,
} from './helpers.ts';

const ctx = createTestContext();
const { pool, orderService } = ctx;

beforeEach(async () => {
  await resetDatabase(pool);
  await orderService.loadOpenOrders(); // empty the in-memory books too
  ctx.prices.set('BTC-USD', price('50000'));
  ctx.prices.set('ETH-USD', price('2000'));
});

afterAll(async () => {
  await pool.end();
});

async function expectError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('placing orders', () => {
  it('rests a limit buy and holds exactly price × quantity', async () => {
    const alice = await createTrader(pool);
    const order = await orderService.placeOrder(
      alice.id,
      limitOrder('BTC-USD', 'buy', '49000', '0.5'),
    );

    expect(order).toMatchObject({
      status: 'open',
      price: '49000',
      quantity: '0.5',
      filledQuantity: '0',
    });
    expect(await balancesOf(pool, alice.id)).toMatchObject({
      USD: { available: '75500', held: '24500' },
    });
    expect(orderService.bookSnapshot('BTC-USD').bids).toEqual([
      { price: '49000', quantity: '0.5', orderCount: 1 },
    ]);
  });

  it('rejects an order the user cannot afford and saves nothing', async () => {
    const alice = await createTrader(pool, { USD: '1000' });
    await expectError(
      orderService.placeOrder(alice.id, limitOrder('BTC-USD', 'buy', '50000', '0.1')),
      'INSUFFICIENT_FUNDS',
    );
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM orders');
    expect(rows[0].n).toBe(0);
    expect(await balancesOf(pool, alice.id)).toMatchObject({
      USD: { available: '1000', held: '0' },
    });
    expect(orderService.bookSnapshot('BTC-USD').bids).toEqual([]);
  });

  it('rejects selling coins the user does not own', async () => {
    const alice = await createTrader(pool);
    await expectError(
      orderService.placeOrder(alice.id, limitOrder('BTC-USD', 'sell', '50000', '0.1')),
      'INSUFFICIENT_FUNDS',
    );
  });

  it('rejects prices outside the band and when the price feed is down', async () => {
    const alice = await createTrader(pool);
    await expectError(
      orderService.placeOrder(alice.id, limitOrder('BTC-USD', 'buy', '40000', '0.1')),
      'PRICE_OUT_OF_BAND',
    );

    const offline = new OrderService({
      pool,
      events: ctx.events,
      prices: { getReferencePrice: () => null },
    });
    await expectError(
      offline.placeOrder(alice.id, limitOrder('BTC-USD', 'buy', '50000', '0.1')),
      'MARKET_DATA_UNAVAILABLE',
    );
  });
});

describe('matching and settlement', () => {
  it('trades at the maker price and refunds the buyer the difference', async () => {
    const seller = await createTrader(pool, { USD: '0', BTC: '1' });
    const buyer = await createTrader(pool);
    const supply = await totalSupply(pool);

    const ask = await orderService.placeOrder(
      seller.id,
      limitOrder('BTC-USD', 'sell', '50000', '0.1'),
    );
    const bid = await orderService.placeOrder(
      buyer.id,
      limitOrder('BTC-USD', 'buy', '50100', '0.1'),
    );

    expect(bid).toMatchObject({ status: 'filled', filledQuantity: '0.1' });
    expect(await balancesOf(pool, buyer.id)).toMatchObject({
      USD: { available: '95000', held: '0' }, // paid 5,000 not 5,010
      BTC: { available: '0.1', held: '0' },
    });
    expect(await balancesOf(pool, seller.id)).toMatchObject({
      USD: { available: '5000', held: '0' },
      BTC: { available: '0.9', held: '0' },
    });

    const { rows } = await pool.query(
      'SELECT price::text, quantity::text, maker_order_id, taker_order_id FROM trades',
    );
    expect(rows).toEqual([
      { price: '5000000', quantity: '10000000', maker_order_id: ask.id, taker_order_id: bid.id },
    ]);
    await expectAllInvariants(ctx, supply);
  });

  it('partially fills a resting order and keeps the right amount held', async () => {
    const seller = await createTrader(pool, { BTC: '1' });
    const buyer = await createTrader(pool);
    const supply = await totalSupply(pool);

    const ask = await orderService.placeOrder(
      seller.id,
      limitOrder('BTC-USD', 'sell', '50000', '0.3'),
    );
    await orderService.placeOrder(buyer.id, limitOrder('BTC-USD', 'buy', '50000', '0.1'));

    const { rows } = await pool.query(
      'SELECT status, filled_quantity::text FROM orders WHERE id = $1',
      [ask.id],
    );
    expect(rows[0]).toEqual({ status: 'open', filled_quantity: '10000000' });
    expect(await balancesOf(pool, seller.id)).toMatchObject({
      BTC: { available: '0.7', held: '0.2' },
    });
    expect(orderService.bookSnapshot('BTC-USD').asks).toEqual([
      { price: '50000', quantity: '0.2', orderCount: 1 },
    ]);
    await expectAllInvariants(ctx, supply);
  });

  it('sweeps several price levels and rests the remainder', async () => {
    const sellers = [
      await createTrader(pool, { BTC: '1' }),
      await createTrader(pool, { BTC: '1' }),
    ];
    const buyer = await createTrader(pool);
    const supply = await totalSupply(pool);

    await orderService.placeOrder(sellers[0]!.id, limitOrder('BTC-USD', 'sell', '50000', '0.1'));
    await orderService.placeOrder(sellers[1]!.id, limitOrder('BTC-USD', 'sell', '50100', '0.1'));
    const bid = await orderService.placeOrder(
      buyer.id,
      limitOrder('BTC-USD', 'buy', '50200', '0.3'),
    );

    expect(bid).toMatchObject({ status: 'open', filledQuantity: '0.2' });
    // Paid 5,000 + 5,010; 0.1 still resting at 50,200 → 5,020 held.
    expect(await balancesOf(pool, buyer.id)).toMatchObject({
      USD: { available: '84970', held: '5020' },
      BTC: { available: '0.2' },
    });
    await expectAllInvariants(ctx, supply);
  });

  it('fills a market buy within the protection price and cancels the rest', async () => {
    const seller = await createTrader(pool, { BTC: '1' });
    const buyer = await createTrader(pool);
    const supply = await totalSupply(pool);

    await orderService.placeOrder(seller.id, limitOrder('BTC-USD', 'sell', '51000', '0.1'));
    // +6% — beyond the 5% market-order protection, so it must not be hit.
    await orderService.placeOrder(seller.id, limitOrder('BTC-USD', 'sell', '53000', '0.1'));

    const order = await orderService.placeOrder(buyer.id, marketOrder('BTC-USD', 'buy', '0.2'));
    expect(order).toMatchObject({
      type: 'market',
      status: 'cancelled',
      cancelReason: 'unfilled_remainder',
      filledQuantity: '0.1',
      price: '52500', // the protection price
    });
    expect(await balancesOf(pool, buyer.id)).toMatchObject({
      USD: { available: '94900', held: '0' },
      BTC: { available: '0.1' },
    });
    await expectAllInvariants(ctx, supply);
  });

  it('cancels a market order with no liquidity and returns its hold', async () => {
    const buyer = await createTrader(pool);
    const order = await orderService.placeOrder(buyer.id, marketOrder('ETH-USD', 'buy', '1'));
    expect(order).toMatchObject({ status: 'cancelled', filledQuantity: '0' });
    expect(await balancesOf(pool, buyer.id)).toMatchObject({
      USD: { available: '100000', held: '0' },
    });
  });

  it('refuses to let a user trade with themself', async () => {
    const alice = await createTrader(pool, { BTC: '1' });
    const supply = await totalSupply(pool);

    await orderService.placeOrder(alice.id, limitOrder('BTC-USD', 'sell', '50000', '0.1'));
    const buy = await orderService.placeOrder(
      alice.id,
      limitOrder('BTC-USD', 'buy', '50000', '0.1'),
    );

    expect(buy).toMatchObject({ status: 'cancelled', cancelReason: 'self_trade_prevention' });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM trades');
    expect(rows[0].n).toBe(0);
    expect(await balancesOf(pool, alice.id)).toMatchObject({
      USD: { available: '100000', held: '0' },
      BTC: { available: '0.9', held: '0.1' },
    });
    await expectAllInvariants(ctx, supply);
  });

  it('announces trades, fills, order updates and balance changes after commit', async () => {
    const seller = await createTrader(pool, { BTC: '1' });
    const buyer = await createTrader(pool);
    const seen: string[] = [];
    ctx.events.on('trade', () => seen.push('trade'));
    ctx.events.on('fill', (userId, fill) => seen.push(`fill:${userId}:${fill.role}`));
    ctx.events.on('orderUpdated', (userId, order) => seen.push(`order:${userId}:${order.status}`));
    ctx.events.on('balancesChanged', (ids) => seen.push(`balances:${ids.join(',')}`));
    ctx.events.on('bookChanged', (market) => seen.push(`book:${market}`));

    await orderService.placeOrder(seller.id, limitOrder('BTC-USD', 'sell', '50000', '0.1'));
    seen.length = 0;
    await orderService.placeOrder(buyer.id, limitOrder('BTC-USD', 'buy', '50000', '0.1'));

    expect(seen).toEqual([
      'trade',
      `fill:${buyer.id}:taker`,
      `fill:${seller.id}:maker`,
      `order:${buyer.id}:filled`,
      `order:${seller.id}:filled`,
      `balances:${seller.id},${buyer.id}`,
      'book:BTC-USD',
    ]);
    ctx.events.removeAllListeners();
  });
});

describe('cancelling orders', () => {
  it('releases the hold and removes the order from the book', async () => {
    const alice = await createTrader(pool);
    const order = await orderService.placeOrder(
      alice.id,
      limitOrder('ETH-USD', 'buy', '1990', '2'),
    );
    const cancelled = await orderService.cancelOrder(alice.id, order.id);

    expect(cancelled).toMatchObject({ status: 'cancelled', cancelReason: 'user' });
    expect(await balancesOf(pool, alice.id)).toMatchObject({
      USD: { available: '100000', held: '0' },
    });
    expect(orderService.bookSnapshot('ETH-USD').bids).toEqual([]);
  });

  it('releases only the unfilled remainder of a partially filled order', async () => {
    const seller = await createTrader(pool, { ETH: '5' });
    const buyer = await createTrader(pool);
    const ask = await orderService.placeOrder(
      seller.id,
      limitOrder('ETH-USD', 'sell', '2000', '3'),
    );
    await orderService.placeOrder(buyer.id, limitOrder('ETH-USD', 'buy', '2000', '1'));
    await orderService.cancelOrder(seller.id, ask.id);

    expect(await balancesOf(pool, seller.id)).toMatchObject({
      ETH: { available: '4', held: '0' },
      USD: { available: '102000' },
    });
  });

  it('will not cancel twice, or cancel someone else’s order', async () => {
    const alice = await createTrader(pool);
    const mallory = await createTrader(pool);
    const order = await orderService.placeOrder(
      alice.id,
      limitOrder('BTC-USD', 'buy', '49000', '0.1'),
    );

    await expectError(orderService.cancelOrder(mallory.id, order.id), 'NOT_FOUND');
    await orderService.cancelOrder(alice.id, order.id);
    const second = orderService.cancelOrder(alice.id, order.id);
    await expect(second).rejects.toBeInstanceOf(AppError);
    await expectError(second, 'ORDER_NOT_OPEN');
  });
});

describe('concurrency', () => {
  it('never lets simultaneous orders spend the same dollars twice', async () => {
    const alice = await createTrader(pool, { USD: '1000' });
    // Ten $200 orders at once with only $1,000: exactly five can be accepted.
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        orderService.placeOrder(alice.id, limitOrder('BTC-USD', 'buy', '50000', '0.004')),
      ),
    );
    const accepted = attempts.filter((attempt) => attempt.status === 'fulfilled');
    const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
    expect(accepted).toHaveLength(5);
    expect(rejected).toHaveLength(5);
    expect(await balancesOf(pool, alice.id)).toMatchObject({
      USD: { available: '0', held: '1000' },
    });
    await expectHeldMatchesOpenOrders(pool);
  });

  it('shares one cash balance safely across markets running in parallel', async () => {
    const alice = await createTrader(pool, { USD: '1000' });
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        orderService.placeOrder(
          alice.id,
          i % 2 === 0
            ? limitOrder('BTC-USD', 'buy', '50000', '0.004')
            : limitOrder('ETH-USD', 'buy', '2000', '0.1'),
        ),
      ),
    );
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(5);
    expect(await balancesOf(pool, alice.id)).toMatchObject({
      USD: { available: '0', held: '1000' },
    });
    await expectHeldMatchesOpenOrders(pool);
  });

  it('keeps every invariant through a storm of random concurrent orders and cancels', async () => {
    const traders = await Promise.all(
      Array.from({ length: 6 }, () => createTrader(pool, { USD: '20000', BTC: '0.5', ETH: '10' })),
    );
    const supply = await totalSupply(pool);
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };

    const placed: Array<{ userId: string; order: OrderDto }> = [];
    const tasks: Array<Promise<unknown>> = [];
    for (let i = 0; i < 300; i++) {
      const trader = traders[Math.floor(random() * traders.length)]!;
      const market: MarketSymbol = random() < 0.5 ? 'BTC-USD' : 'ETH-USD';
      const side = random() < 0.5 ? 'buy' : 'sell';
      const reference = market === 'BTC-USD' ? 50_000 : 2_000;
      const offsetPct = (random() - 0.5) * 0.04; // ±2%
      const limit = (reference * (1 + offsetPct)).toFixed(2);
      const quantity =
        market === 'BTC-USD'
          ? (0.001 + Math.floor(random() * 20) * 0.001).toFixed(3)
          : (0.1 + Math.floor(random() * 20) * 0.1).toFixed(1);

      if (random() < 0.15 && placed.length > 0) {
        const target = placed[Math.floor(random() * placed.length)]!;
        tasks.push(orderService.cancelOrder(target.userId, target.order.id).catch(() => undefined));
        continue;
      }
      const input =
        random() < 0.2
          ? marketOrder(market, side, quantity)
          : limitOrder(market, side, limit, quantity);
      tasks.push(
        orderService
          .placeOrder(trader.id, input)
          .then((order) => placed.push({ userId: trader.id, order }))
          .catch((error: unknown) => {
            // Rejections are fine (no funds, no liquidity) — but only expected ones.
            expect((error as { code?: string }).code).toBe('INSUFFICIENT_FUNDS');
          }),
      );
    }
    await Promise.all(tasks);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM trades');
    expect(rows[0].n).toBeGreaterThan(20); // the storm actually produced trades
    await expectAllInvariants(ctx, supply);
  });
});

describe('restart recovery', () => {
  it('rebuilds the books from the database with time priority intact', async () => {
    const first = await createTrader(pool, { BTC: '1' });
    const second = await createTrader(pool, { BTC: '1' });
    const buyer = await createTrader(pool);
    const early = await orderService.placeOrder(
      first.id,
      limitOrder('BTC-USD', 'sell', '50000', '0.1'),
    );
    await orderService.placeOrder(second.id, limitOrder('BTC-USD', 'sell', '50000', '0.1'));
    await orderService.placeOrder(buyer.id, limitOrder('BTC-USD', 'buy', '49000', '0.2'));

    // Simulate a server restart: a brand-new service with empty memory.
    const restarted = new OrderService({ pool, prices: ctx.prices, events: ctx.events });
    expect(await restarted.loadOpenOrders()).toBe(3);
    expect(restarted.bookSnapshot('BTC-USD')).toEqual(orderService.bookSnapshot('BTC-USD'));

    // The earlier order at the same price must still fill first.
    await restarted.placeOrder(buyer.id, limitOrder('BTC-USD', 'buy', '50000', '0.1'));
    const { rows } = await pool.query('SELECT maker_order_id FROM trades');
    expect(rows).toEqual([{ maker_order_id: early.id }]);

    await orderService.loadOpenOrders();
    await expectBookMatchesDatabase(ctx, 'BTC-USD');
  });
});
