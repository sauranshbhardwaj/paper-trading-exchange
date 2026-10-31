import http from 'node:http';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createPool } from './db/pool.ts';
import { migrate } from './db/migrate.ts';
import { ExchangeEvents } from './events.ts';
import { CoinbaseFeed } from './market-data/coinbaseFeed.ts';
import { PriceBoard } from './market-data/priceBoard.ts';
import { RandomWalkFeed } from './market-data/randomWalkFeed.ts';
import { RealtimeHub } from './realtime/hub.ts';
import { OrderService } from './trading/orderService.ts';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);

const applied = await migrate(pool);
if (applied.length) console.log(`[db] applied migrations: ${applied.join(', ')}`);

const events = new ExchangeEvents();
const prices = new PriceBoard();
const feed = config.PRICE_FEED === 'mock' ? new RandomWalkFeed(prices) : new CoinbaseFeed(prices);
const orderService = new OrderService({ pool, prices, events });

const restored = await orderService.loadOpenOrders();
console.log(`[orders] restored ${restored} open orders from the database`);

const ctx = { config, pool, events, prices, orderService };
const server = http.createServer(createApp(ctx));
const hub = new RealtimeHub(ctx);
hub.attach(server);
feed.start();

server.listen(config.PORT, () => {
  console.log(`[http] listening on http://localhost:${config.PORT} (${config.NODE_ENV})`);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[http] ${signal} received, shutting down`);
  feed.stop();
  hub.close();
  server.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
