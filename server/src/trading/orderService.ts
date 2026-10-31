/**
 * The heart of the exchange: places and cancels orders.
 *
 * Placing an order, step by step (all inside one per-market queue slot):
 *   1. Validate against market rules and the live price (shared resolveOrder).
 *   2. BEGIN a transaction and insert the order row (its id = time priority).
 *   3. Ask the in-memory book what would match. This does NOT change the book.
 *   4. Turn the matches into balance deltas, trades and order updates (pure).
 *   5. Lock every balance row involved (sorted, deadlock-free), check the
 *      user can afford the order, write everything, COMMIT.
 *   6. Only after COMMIT, apply the matches to the in-memory book and
 *      announce events. If anything failed, the book was never touched.
 */
import {
  ASSET_DECIMALS,
  formatCash,
  formatUnits,
  MARKET_ORDER_PROTECTION_BPS,
  MARKET_SYMBOLS,
  MARKETS,
  PRICE_DECIMALS,
  QTY_DECIMALS,
  resolveOrder,
  type Asset,
  type BookDto,
  type BookLevelDto,
  type MarketSymbol,
  type OrderDto,
  type OrderSide,
  type PlaceOrderParsed,
} from '@pte/shared';
import { withTransaction, type Pool } from '../db/pool.ts';
import { AppError, notFound } from '../errors.ts';
import type { ExchangeEvents } from '../events.ts';
import { OrderBook, type BookLevel, type IncomingOrder } from '../engine/orderBook.ts';
import { computeCancellation, computeSettlement, type Settlement } from '../engine/settlement.ts';
import { applyBalanceDeltas, lockBalances } from './balancesRepo.ts';
import {
  applyMakerFills,
  finalizeTakerOrder,
  findOrderForUser,
  insertOrder,
  listOpenOrders,
  markCancelled,
  remainingOf,
  toOrderDto,
  type OrderRecord,
} from './ordersRepo.ts';
import { insertTrades, toTradeDto, type StoredTrade } from './tradesRepo.ts';
import { KeyedSerialQueue } from './serialQueue.ts';

export interface PriceSource {
  /** Fresh reference price in price units, or null if unavailable/stale. */
  getReferencePrice(market: MarketSymbol): bigint | null;
}

export interface OrderServiceDeps {
  pool: Pool;
  prices: PriceSource;
  events: ExchangeEvents;
}

export const DEFAULT_BOOK_DEPTH = 20;

interface ExecutedOrder {
  incoming: IncomingOrder;
  result: ReturnType<OrderBook['match']>;
  settlement: Settlement;
  takerOrder: OrderRecord;
  makerOrders: OrderRecord[];
  trades: StoredTrade[];
}

function formatAmount(asset: Asset, units: bigint): string {
  return asset === 'USD'
    ? formatCash(units)
    : `${formatUnits(units, ASSET_DECIMALS[asset])} ${asset}`;
}

function toLevelDto(level: BookLevel): BookLevelDto {
  return {
    price: formatUnits(level.price, PRICE_DECIMALS),
    quantity: formatUnits(level.quantity, QTY_DECIMALS),
    orderCount: level.orderCount,
  };
}

export class OrderService {
  private readonly pool: Pool;
  private readonly prices: PriceSource;
  private readonly events: ExchangeEvents;
  private readonly queue = new KeyedSerialQueue();
  private readonly books = new Map<MarketSymbol, OrderBook>();

  constructor(deps: OrderServiceDeps) {
    this.pool = deps.pool;
    this.prices = deps.prices;
    this.events = deps.events;
    for (const symbol of MARKET_SYMBOLS) this.books.set(symbol, new OrderBook(symbol));
  }

  /**
   * Rebuild every in-memory book from open orders in Postgres. Run on startup:
   * the database is the source of truth, the book is a fast cache of it.
   */
  async loadOpenOrders(): Promise<number> {
    let total = 0;
    for (const symbol of MARKET_SYMBOLS) {
      await this.queue.run(symbol, async () => {
        const book = new OrderBook(symbol);
        const orders = await listOpenOrders(this.pool, symbol);
        for (const order of orders) {
          book.add({
            id: order.id,
            userId: order.userId,
            side: order.side,
            price: order.price,
            remaining: remainingOf(order),
          });
        }
        const bid = book.bestBid();
        const ask = book.bestAsk();
        if (bid !== null && ask !== null && bid >= ask) {
          console.warn(
            `[orders] ${symbol} book is crossed after reload (bid ${bid} >= ask ${ask})`,
          );
        }
        this.books.set(symbol, book);
        total += orders.length;
      });
    }
    return total;
  }

  bookSnapshot(market: MarketSymbol, depth = DEFAULT_BOOK_DEPTH): BookDto {
    const { bids, asks } = this.bookFor(market).snapshot(depth);
    return { market, bids: bids.map(toLevelDto), asks: asks.map(toLevelDto) };
  }

  placeOrder(userId: string, input: PlaceOrderParsed): Promise<OrderDto> {
    return this.queue.run(input.market, () => this.executeOrder(userId, input));
  }

  async cancelOrder(userId: string, orderId: string): Promise<OrderDto> {
    // Read once outside the queue just to learn which market's queue to join.
    const existing = await findOrderForUser(this.pool, orderId, userId);
    if (!existing) throw notFound('Order');

    return this.queue.run(existing.market, async () => {
      const market = MARKETS[existing.market];
      const cancelled = await withTransaction(this.pool, async (client) => {
        const order = await findOrderForUser(client, orderId, userId, { forUpdate: true });
        if (!order) throw notFound('Order');
        if (order.status !== 'open') {
          throw new AppError(409, 'ORDER_NOT_OPEN', `This order is already ${order.status}`);
        }
        const deltas = computeCancellation(market, {
          userId,
          side: order.side,
          limitPrice: order.price,
          remaining: remainingOf(order),
        });
        await applyBalanceDeltas(client, deltas.list());
        return markCancelled(client, order.id, 'user');
      });

      this.bookFor(market.symbol).remove(cancelled.id);
      this.publish(() => {
        this.events.emit('orderUpdated', userId, toOrderDto(cancelled));
        this.events.emit('balancesChanged', [userId]);
        this.events.emit('bookChanged', market.symbol);
      });
      return toOrderDto(cancelled);
    });
  }

  private async executeOrder(userId: string, input: PlaceOrderParsed): Promise<OrderDto> {
    const market = MARKETS[input.market];
    const book = this.bookFor(market.symbol);
    const resolved = resolveOrder(
      market,
      {
        market: input.market,
        side: input.side,
        type: input.type,
        price: input.type === 'limit' ? input.price : undefined,
        quantity: input.quantity,
      },
      this.prices.getReferencePrice(market.symbol),
    );

    const executed = await withTransaction(this.pool, async (client): Promise<ExecutedOrder> => {
      const row = await insertOrder(client, {
        userId,
        market: market.symbol,
        side: input.side,
        type: input.type,
        price: resolved.limitPrice,
        quantity: input.quantity,
      });
      const incoming: IncomingOrder = {
        id: row.id,
        userId,
        side: input.side,
        price: resolved.limitPrice,
        remaining: input.quantity,
        timeInForce: resolved.timeInForce,
      };

      const result = book.match(incoming);
      const settlement = computeSettlement(
        market,
        {
          id: row.id,
          userId,
          side: input.side,
          limitPrice: resolved.limitPrice,
          quantity: input.quantity,
        },
        result,
      );

      const locked = await lockBalances(client, settlement.deltas.keys());
      const funding = locked.find((b) => b.userId === userId && b.asset === resolved.holdAsset);
      if (!funding || funding.available < resolved.holdAmount) {
        throw this.insufficientFunds(
          resolved.holdAsset,
          funding?.available ?? 0n,
          resolved.holdAmount,
          input.type === 'market' && input.side === 'buy',
        );
      }

      await applyBalanceDeltas(client, settlement.deltas.list());
      const trades = await insertTrades(client, market.symbol, settlement.trades);
      const makerOrders = await applyMakerFills(client, settlement.makerUpdates);
      const takerOrder = await finalizeTakerOrder(
        client,
        row.id,
        settlement.takerFilled,
        settlement.takerStatus,
        settlement.takerCancelReason,
      );
      return { incoming, result, settlement, takerOrder, makerOrders, trades };
    });

    // Committed. Now (and only now) update memory and tell everyone.
    book.apply(executed.incoming, executed.result);
    this.publish(() => this.announceExecution(executed));
    return toOrderDto(executed.takerOrder);
  }

  private announceExecution({ settlement, takerOrder, makerOrders, trades }: ExecutedOrder): void {
    const opposite: Record<OrderSide, OrderSide> = { buy: 'sell', sell: 'buy' };
    for (const trade of trades) {
      const dto = toTradeDto(trade);
      this.events.emit('trade', dto);
      const makerUserId = trade.takerSide === 'buy' ? trade.sellerId : trade.buyerId;
      const takerUserId = trade.takerSide === 'buy' ? trade.buyerId : trade.sellerId;
      const fill = { market: trade.market, price: dto.price, quantity: dto.quantity };
      this.events.emit('fill', takerUserId, {
        ...fill,
        orderId: trade.takerOrderId,
        side: trade.takerSide,
        role: 'taker',
      });
      this.events.emit('fill', makerUserId, {
        ...fill,
        orderId: trade.makerOrderId,
        side: opposite[trade.takerSide],
        role: 'maker',
      });
    }
    this.events.emit('orderUpdated', takerOrder.userId, toOrderDto(takerOrder));
    for (const maker of makerOrders)
      this.events.emit('orderUpdated', maker.userId, toOrderDto(maker));
    this.events.emit('balancesChanged', settlement.deltas.userIds());
    this.events.emit('bookChanged', takerOrder.market);
  }

  private insufficientFunds(
    asset: Asset,
    available: bigint,
    required: bigint,
    isMarketBuy: boolean,
  ) {
    const hint = isMarketBuy
      ? ` (market buys reserve up to ${MARKET_ORDER_PROTECTION_BPS / 100}% above the live price; unused funds are returned instantly)`
      : '';
    return new AppError(
      400,
      'INSUFFICIENT_FUNDS',
      `Not enough ${asset}: this order needs ${formatAmount(asset, required)} but you have ${formatAmount(asset, available)} available${hint}`,
    );
  }

  /** Events go out after the commit. A failing listener must not turn a successful trade into an error. */
  private publish(announce: () => void): void {
    try {
      announce();
    } catch (error) {
      console.error('[orders] failed to publish events:', error);
    }
  }

  private bookFor(market: MarketSymbol): OrderBook {
    const book = this.books.get(market);
    if (!book) throw new Error(`No order book for ${market}`);
    return book;
  }
}
