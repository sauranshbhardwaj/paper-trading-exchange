/**
 * Offline stand-in for Coinbase (PRICE_FEED=mock): a random walk around
 * realistic prices, so you can develop on a plane or behind a firewall.
 */
import { parseUnits, PRICE_DECIMALS, scaleByBps, type MarketSymbol } from '@pte/shared';
import type { PriceBoard, PriceFeed } from './priceBoard.ts';

const STARTING_PRICES: Record<MarketSymbol, string> = {
  'BTC-USD': '77000.00',
  'ETH-USD': '2250.00',
};
const TICK_MS = 1_000;
const MAX_STEP_BPS = 5; // ±0.05% per tick

export class RandomWalkFeed implements PriceFeed {
  private readonly board: PriceBoard;
  private readonly prices = new Map<MarketSymbol, bigint>();
  private timer: NodeJS.Timeout | null = null;

  constructor(board: PriceBoard) {
    this.board = board;
  }

  start(): void {
    for (const [market, price] of Object.entries(STARTING_PRICES) as [MarketSymbol, string][]) {
      this.prices.set(market, parseUnits(price, PRICE_DECIMALS));
      this.board.set(market, this.prices.get(market)!);
    }
    this.timer = setInterval(() => this.step(), TICK_MS);
    this.timer.unref();
    console.log('[mock-feed] generating random-walk prices');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private step(): void {
    for (const [market, price] of this.prices) {
      const stepBps = Math.round((Math.random() * 2 - 1) * MAX_STEP_BPS);
      const next = scaleByBps(price, 10_000 + stepBps, 'floor');
      this.prices.set(market, next);
      this.board.set(market, next);
    }
  }
}
