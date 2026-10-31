import { expect } from 'vitest';
import {
  ASSET_DECIMALS,
  ASSETS,
  CASH_DECIMALS,
  formatUnits,
  MARKET_SYMBOLS,
  parseUnits,
  PRICE_DECIMALS,
  QTY_DECIMALS,
  type Asset,
  type MarketSymbol,
  type PlaceOrderParsed,
} from '@pte/shared';
import { registerUser, type AuthUser } from '../src/auth/users.ts';
import type { Config } from '../src/config.ts';
import type { AppContext } from '../src/context.ts';
import { createPool, type Pool } from '../src/db/pool.ts';
import { ExchangeEvents } from '../src/events.ts';
import { PriceBoard } from '../src/market-data/priceBoard.ts';
import { OrderService } from '../src/trading/orderService.ts';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://pte:pte@localhost:5433/pte_test';

export const price = (value: string) => parseUnits(value, PRICE_DECIMALS);
export const qty = (value: string) => parseUnits(value, QTY_DECIMALS);
export const cash = (value: string) => parseUnits(value, CASH_DECIMALS);

export const REFERENCE_PRICES: Record<MarketSymbol, bigint> = {
  'BTC-USD': price('50000'),
  'ETH-USD': price('2000'),
};

export function createTestContext(): AppContext {
  const pool = createPool(TEST_DATABASE_URL);
  const events = new ExchangeEvents();
  const prices = new PriceBoard();
  for (const market of MARKET_SYMBOLS) prices.set(market, REFERENCE_PRICES[market]);
  const orderService = new OrderService({ pool, prices, events });
  const config: Config = {
    NODE_ENV: 'test',
    PORT: 0,
    DATABASE_URL: TEST_DATABASE_URL,
    PRICE_FEED: 'mock',
    isProduction: false,
  };
  return { config, pool, events, prices, orderService };
}

export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE users, sessions, balances, orders, trades RESTART IDENTITY CASCADE');
}

let traderCount = 0;

/** A user with the given starting balances (decimal strings), USD defaulting to $100,000. */
export async function createTrader(
  pool: Pool,
  balances: Partial<Record<Asset, string>> = {},
): Promise<AuthUser> {
  traderCount += 1;
  const startingBalances: Partial<Record<Asset, bigint>> = {};
  for (const asset of ASSETS) {
    const fallback = asset === 'USD' ? '100000' : '0';
    startingBalances[asset] = parseUnits(balances[asset] ?? fallback, ASSET_DECIMALS[asset]);
  }
  return registerUser(
    pool,
    {
      email: `trader${traderCount}@test.dev`,
      password: 'password123',
      displayName: `trader${traderCount}`,
    },
    { startingBalances },
  );
}

export function limitOrder(
  market: MarketSymbol,
  side: 'buy' | 'sell',
  priceValue: string,
  quantity: string,
): PlaceOrderParsed {
  return { type: 'limit', market, side, price: price(priceValue), quantity: qty(quantity) };
}

export function marketOrder(
  market: MarketSymbol,
  side: 'buy' | 'sell',
  quantity: string,
): PlaceOrderParsed {
  return { type: 'market', market, side, quantity: qty(quantity) };
}

/** Balances as readable decimal strings: { USD: { available: '99000', held: '1000' }, ... } */
export async function balancesOf(
  pool: Pool,
  userId: string,
): Promise<Record<Asset, { available: string; held: string }>> {
  const { rows } = await pool.query<{ asset: Asset; available: string; held: string }>(
    'SELECT asset, available, held FROM balances WHERE user_id = $1',
    [userId],
  );
  const result = {} as Record<Asset, { available: string; held: string }>;
  for (const row of rows) {
    const decimals = ASSET_DECIMALS[row.asset];
    result[row.asset] = {
      available: formatUnits(BigInt(row.available), decimals),
      held: formatUnits(BigInt(row.held), decimals),
    };
  }
  return result;
}

/** Total of every asset across all users. Trading must never change these. */
export async function totalSupply(pool: Pool): Promise<Record<string, string>> {
  const { rows } = await pool.query<{ asset: string; total: string }>(
    'SELECT asset, sum(available + held)::text AS total FROM balances GROUP BY asset ORDER BY asset',
  );
  return Object.fromEntries(rows.map((row) => [row.asset, row.total]));
}

/**
 * The core accounting invariant: each user's held balance equals exactly what
 * their open orders need (cash at limit price for buys, coins for sells).
 */
export async function expectHeldMatchesOpenOrders(pool: Pool): Promise<void> {
  const { rows } = await pool.query(`
    SELECT b.user_id, b.asset, b.held::text, coalesce(o.expected, 0)::text AS expected
      FROM balances b
      LEFT JOIN (
        SELECT user_id,
               CASE WHEN side = 'buy' THEN 'USD' ELSE split_part(market, '-', 1) END AS asset,
               sum(CASE WHEN side = 'buy'
                        THEN price::numeric * (quantity - filled_quantity)
                        ELSE quantity - filled_quantity END) AS expected
          FROM orders WHERE status = 'open'
         GROUP BY 1, 2
      ) o ON o.user_id = b.user_id AND o.asset = b.asset
     WHERE b.held <> coalesce(o.expected, 0)`);
  expect(rows).toEqual([]);
}

/** The in-memory book must be an exact mirror of open orders in the database. */
export async function expectBookMatchesDatabase(
  ctx: AppContext,
  market: MarketSymbol,
): Promise<void> {
  const { rows } = await ctx.pool.query<{
    side: string;
    price: string;
    quantity: string;
    count: string;
  }>(
    `SELECT side, price::text, sum(quantity - filled_quantity)::text AS quantity, count(*)::text AS count
       FROM orders WHERE market = $1 AND status = 'open'
      GROUP BY side, price
      ORDER BY side, CASE WHEN side = 'buy' THEN -price ELSE price END`,
    [market],
  );
  const fromDb = (side: string) =>
    rows
      .filter((row) => row.side === side)
      .map((row) => ({
        price: formatUnits(BigInt(row.price), PRICE_DECIMALS),
        quantity: formatUnits(BigInt(row.quantity), QTY_DECIMALS),
        orderCount: Number(row.count),
      }));
  const snapshot = ctx.orderService.bookSnapshot(market, 10_000);
  expect(snapshot.bids).toEqual(fromDb('buy'));
  expect(snapshot.asks).toEqual(fromDb('sell'));
}

export async function expectAllInvariants(ctx: AppContext, supplyBefore: Record<string, string>) {
  expect(await totalSupply(ctx.pool)).toEqual(supplyBefore);
  await expectHeldMatchesOpenOrders(ctx.pool);
  for (const market of MARKET_SYMBOLS) await expectBookMatchesDatabase(ctx, market);
}
