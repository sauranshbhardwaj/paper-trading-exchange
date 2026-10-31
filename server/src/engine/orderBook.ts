/**
 * In-memory limit order book for one market, with price-time priority.
 *
 * The book is deliberately split into two steps:
 *   1. match(order)  — pure: works out the fills without changing anything.
 *   2. apply(result) — mutates the book.
 * The order service saves the fills to Postgres between those two steps, so
 * if the database transaction fails the in-memory book is still untouched.
 */
import type { MarketSymbol, OrderSide, TimeInForce } from '@pte/shared';

export interface BookOrder {
  id: string;
  userId: string;
  side: OrderSide;
  /** Limit price, in price units. */
  price: bigint;
  /** Quantity still open, in quantity units. */
  remaining: bigint;
}

export interface IncomingOrder extends BookOrder {
  timeInForce: TimeInForce;
}

export interface Fill {
  makerOrderId: string;
  makerUserId: string;
  /** Trades happen at the resting (maker) order's price — the taker gets any price improvement. */
  price: bigint;
  quantity: bigint;
  makerRemainingAfter: bigint;
}

export type MatchOutcome =
  /** Incoming order fully filled. */
  | 'filled'
  /** GTC order with quantity left over: the remainder rests on the book. */
  | 'resting'
  /** IOC order with quantity left over: the remainder is cancelled. */
  | 'expired'
  /** Matching stopped at the user's own resting order; the remainder is cancelled. */
  | 'self_trade_prevented';

export interface MatchResult {
  fills: Fill[];
  /** Quantity of the incoming order left after matching. */
  remaining: bigint;
  outcome: MatchOutcome;
}

export interface BookLevel {
  price: bigint;
  quantity: bigint;
  orderCount: number;
}

interface PriceLevel {
  price: bigint;
  /** FIFO queue: earlier orders first (time priority). */
  orders: BookOrder[];
}

/** One side of the book: price levels sorted best-first. */
class BookSide {
  readonly side: OrderSide;
  readonly levels: PriceLevel[] = [];

  constructor(side: OrderSide) {
    this.side = side;
  }

  /** Bids: higher is better. Asks: lower is better. */
  private isBetter(a: bigint, b: bigint): boolean {
    return this.side === 'buy' ? a > b : a < b;
  }

  /** Binary search: index of the first level whose price is not better than `price`. */
  private searchIndex(price: bigint): number {
    let low = 0;
    let high = this.levels.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.isBetter(this.levels[mid]!.price, price)) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  insert(order: BookOrder): void {
    const index = this.searchIndex(order.price);
    const level = this.levels[index];
    if (level && level.price === order.price) {
      level.orders.push(order);
    } else {
      this.levels.splice(index, 0, { price: order.price, orders: [order] });
    }
  }

  remove(order: BookOrder): void {
    const index = this.searchIndex(order.price);
    const level = this.levels[index];
    if (!level || level.price !== order.price) {
      throw new Error(`Order ${order.id} has no price level on the ${this.side} side`);
    }
    const position = level.orders.indexOf(order);
    if (position === -1) throw new Error(`Order ${order.id} is missing from its price level`);
    level.orders.splice(position, 1);
    if (level.orders.length === 0) this.levels.splice(index, 1);
  }

  bestPrice(): bigint | null {
    return this.levels[0]?.price ?? null;
  }

  snapshot(depth: number): BookLevel[] {
    return this.levels.slice(0, depth).map((level) => ({
      price: level.price,
      quantity: level.orders.reduce((sum, order) => sum + order.remaining, 0n),
      orderCount: level.orders.length,
    }));
  }
}

function crosses(side: OrderSide, limitPrice: bigint, restingPrice: bigint): boolean {
  return side === 'buy' ? restingPrice <= limitPrice : restingPrice >= limitPrice;
}

export class OrderBook {
  readonly market: MarketSymbol;
  private readonly bids = new BookSide('buy');
  private readonly asks = new BookSide('sell');
  private readonly ordersById = new Map<string, BookOrder>();

  constructor(market: MarketSymbol) {
    this.market = market;
  }

  get size(): number {
    return this.ordersById.size;
  }

  has(orderId: string): boolean {
    return this.ordersById.has(orderId);
  }

  get(orderId: string): Readonly<BookOrder> | undefined {
    const order = this.ordersById.get(orderId);
    return order ? { ...order } : undefined;
  }

  /** Put an order on the book behind existing orders at its price. */
  add(order: BookOrder): void {
    if (order.remaining <= 0n) throw new Error(`Order ${order.id} has nothing left to rest`);
    if (this.ordersById.has(order.id)) throw new Error(`Order ${order.id} is already on the book`);
    // Copy so callers can't mutate book state through a reference they kept.
    const copy: BookOrder = {
      id: order.id,
      userId: order.userId,
      side: order.side,
      price: order.price,
      remaining: order.remaining,
    };
    this.ordersById.set(copy.id, copy);
    this.sideFor(copy.side).insert(copy);
  }

  /** Remove an order (e.g. cancelled). Returns it, or undefined if it wasn't on the book. */
  remove(orderId: string): BookOrder | undefined {
    const order = this.ordersById.get(orderId);
    if (!order) return undefined;
    this.sideFor(order.side).remove(order);
    this.ordersById.delete(orderId);
    return { ...order };
  }

  /**
   * Work out how `incoming` would trade against the book: best price first,
   * then earliest order first. Pure — the book is not modified.
   */
  match(incoming: IncomingOrder): MatchResult {
    if (incoming.remaining <= 0n) throw new Error(`Order ${incoming.id} has no quantity`);
    if (this.ordersById.has(incoming.id)) {
      throw new Error(`Order ${incoming.id} is already on the book`);
    }

    const opposite = this.sideFor(incoming.side === 'buy' ? 'sell' : 'buy');
    const fills: Fill[] = [];
    let remaining = incoming.remaining;
    let selfTradePrevented = false;

    levels: for (const level of opposite.levels) {
      if (!crosses(incoming.side, incoming.price, level.price)) break;
      for (const maker of level.orders) {
        if (remaining === 0n) break levels;
        if (maker.userId === incoming.userId) {
          // Self-trade prevention ("cancel newest"): stop here and cancel the
          // rest of the incoming order rather than let a user trade with themself.
          selfTradePrevented = true;
          break levels;
        }
        const quantity = remaining < maker.remaining ? remaining : maker.remaining;
        fills.push({
          makerOrderId: maker.id,
          makerUserId: maker.userId,
          price: level.price,
          quantity,
          makerRemainingAfter: maker.remaining - quantity,
        });
        remaining -= quantity;
      }
    }

    let outcome: MatchOutcome;
    if (remaining === 0n) outcome = 'filled';
    else if (selfTradePrevented) outcome = 'self_trade_prevented';
    else if (incoming.timeInForce === 'IOC') outcome = 'expired';
    else outcome = 'resting';

    return { fills, remaining, outcome };
  }

  /**
   * Apply a result from match(). Must be called before anything else changes
   * the book; a stale result is rejected before any state is touched.
   */
  apply(incoming: IncomingOrder, result: MatchResult): void {
    for (const fill of result.fills) {
      const maker = this.ordersById.get(fill.makerOrderId);
      if (!maker || maker.remaining - fill.quantity !== fill.makerRemainingAfter) {
        throw new Error('Stale match result: the book changed after match() ran');
      }
    }

    for (const fill of result.fills) {
      const maker = this.ordersById.get(fill.makerOrderId)!;
      maker.remaining = fill.makerRemainingAfter;
      if (maker.remaining === 0n) this.remove(maker.id);
    }

    if (result.outcome === 'resting') {
      this.add({ ...incoming, remaining: result.remaining });
    }
  }

  bestBid(): bigint | null {
    return this.bids.bestPrice();
  }

  bestAsk(): bigint | null {
    return this.asks.bestPrice();
  }

  snapshot(depth: number): { bids: BookLevel[]; asks: BookLevel[] } {
    return { bids: this.bids.snapshot(depth), asks: this.asks.snapshot(depth) };
  }

  private sideFor(side: OrderSide): BookSide {
    return side === 'buy' ? this.bids : this.asks;
  }
}
