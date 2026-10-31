/**
 * Latest reference price per market, wherever it came from (Coinbase, the
 * offline mock, or a test). Knows nothing about WebSockets or HTTP.
 */
import { EventEmitter } from 'node:events';
import {
  formatUnits,
  MARKET_SYMBOLS,
  PRICE_DECIMALS,
  REFERENCE_PRICE_MAX_AGE_MS,
  type MarketSymbol,
  type TickerDto,
} from '@pte/shared';
import type { PriceSource } from '../trading/orderService.ts';

interface PricePoint {
  price: bigint;
  updatedAt: number;
}

export interface PriceBoardOptions {
  maxAgeMs?: number;
  now?: () => number;
}

export class PriceBoard
  extends EventEmitter<{ update: [market: MarketSymbol] }>
  implements PriceSource
{
  private readonly points = new Map<MarketSymbol, PricePoint>();
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(options: PriceBoardOptions = {}) {
    super();
    this.maxAgeMs = options.maxAgeMs ?? REFERENCE_PRICE_MAX_AGE_MS;
    this.now = options.now ?? Date.now;
  }

  set(market: MarketSymbol, price: bigint): void {
    if (price <= 0n) return;
    this.points.set(market, { price, updatedAt: this.now() });
    this.emit('update', market);
  }

  /**
   * The feed is alive but nothing traded: the last price is still current.
   * Without this, a quiet market would look "stale" and pause trading.
   */
  confirmAll(): void {
    for (const [market, point] of this.points) {
      const wasStale = !this.isFresh(market);
      point.updatedAt = this.now();
      if (wasStale) this.emit('update', market);
    }
  }

  isFresh(market: MarketSymbol): boolean {
    const point = this.points.get(market);
    return point !== undefined && this.now() - point.updatedAt <= this.maxAgeMs;
  }

  getReferencePrice(market: MarketSymbol): bigint | null {
    return this.isFresh(market) ? this.points.get(market)!.price : null;
  }

  getTicker(market: MarketSymbol): TickerDto {
    const point = this.points.get(market);
    return {
      market,
      referencePrice: point ? formatUnits(point.price, PRICE_DECIMALS) : null,
      updatedAt: point ? new Date(point.updatedAt).toISOString() : null,
      stale: !this.isFresh(market),
    };
  }

  freshness(): Record<MarketSymbol, boolean> {
    return Object.fromEntries(MARKET_SYMBOLS.map((m) => [m, this.isFresh(m)])) as Record<
      MarketSymbol,
      boolean
    >;
  }
}

/** Anything that pushes prices into a PriceBoard. */
export interface PriceFeed {
  start(): void;
  stop(): void;
}
