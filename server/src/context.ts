import type { Config } from './config.ts';
import type { Pool } from './db/pool.ts';
import type { ExchangeEvents } from './events.ts';
import type { PriceBoard } from './market-data/priceBoard.ts';
import type { OrderService } from './trading/orderService.ts';

/** Everything the HTTP and WebSocket layers need, created once in index.ts (or by tests). */
export interface AppContext {
  config: Config;
  pool: Pool;
  events: ExchangeEvents;
  prices: PriceBoard;
  orderService: OrderService;
}
