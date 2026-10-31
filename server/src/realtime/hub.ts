/**
 * WebSocket fan-out. Clients subscribe to markets for public data (book,
 * trades, ticker). Logged-in clients also get private messages (their order
 * updates, fills, balances) — identified by the same session cookie as HTTP.
 *
 * Book and ticker updates are coalesced: if 50 orders hit the book within
 * one flush interval, clients get one snapshot, not 50.
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { clientMessageSchema, type MarketSymbol, type ServerMessage } from '@pte/shared';
import { findUserBySessionToken, hashToken, readSessionToken } from '../auth/sessions.ts';
import type { AppContext } from '../context.ts';
import { listBalancesForUsers, toBalanceDto } from '../trading/balancesRepo.ts';
import { recentTrades } from '../trading/tradesRepo.ts';

const FLUSH_INTERVAL_MS = 150;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_MESSAGE_BYTES = 4 * 1024;
const RECENT_TRADES_LIMIT = 50;
export const WS_PATH = '/ws';

interface Client {
  socket: WebSocket;
  userId: string | null;
  sessionHash: string | null;
  markets: Set<MarketSymbol>;
  alive: boolean;
}

type HubContext = Pick<AppContext, 'pool' | 'events' | 'prices' | 'orderService'>;

export class RealtimeHub {
  private readonly ctx: HubContext;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  private readonly clients = new Set<Client>();
  private readonly dirtyBooks = new Set<MarketSymbol>();
  private readonly dirtyTickers = new Set<MarketSymbol>();
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(ctx: HubContext) {
    this.ctx = ctx;
    const { events, prices } = ctx;

    events.on('bookChanged', (market) => this.dirtyBooks.add(market));
    prices.on('update', (market) => this.dirtyTickers.add(market));
    events.on('trade', (trade) => this.broadcast(trade.market, { type: 'trade', trade }));
    events.on('orderUpdated', (userId, order) => this.sendToUser(userId, { type: 'order', order }));
    events.on('fill', (userId, fill) => this.sendToUser(userId, { type: 'fill', fill }));
    events.on('balancesChanged', (userIds) => void this.pushBalances(userIds));
    events.on('sessionEnded', (sessionHash) => this.disconnectSession(sessionHash));
  }

  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => void this.handleUpgrade(req, socket, head));
    this.timers.push(setInterval(() => this.flush(), FLUSH_INTERVAL_MS));
    this.timers.push(setInterval(() => this.checkHeartbeats(), HEARTBEAT_INTERVAL_MS));
    for (const timer of this.timers) timer.unref();
  }

  close(): void {
    for (const timer of this.timers) clearInterval(timer);
    for (const client of this.clients) client.socket.terminate();
    this.clients.clear();
    this.wss.close();
  }

  get connectionCount(): number {
    return this.clients.size;
  }

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    try {
      const token = readSessionToken(req.headers.cookie);
      const user = token ? await findUserBySessionToken(this.ctx.pool, token) : null;
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.register(ws, user?.id ?? null, user && token ? hashToken(token) : null);
      });
    } catch (error) {
      console.error('[ws] upgrade failed:', error);
      socket.destroy();
    }
  }

  private register(socket: WebSocket, userId: string | null, sessionHash: string | null): void {
    const client: Client = { socket, userId, sessionHash, markets: new Set(), alive: true };
    this.clients.add(client);
    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('message', (data) => void this.handleMessage(client, data));
    socket.on('close', () => this.clients.delete(client));
    socket.on('error', (error) => console.warn('[ws] client error:', error.message));
  }

  private async handleMessage(client: Client, data: RawData): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(data.toString());
    } catch {
      this.send(client, { type: 'error', message: 'Messages must be JSON' });
      return;
    }
    const parsed = clientMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.send(client, { type: 'error', message: 'Unsupported message' });
      return;
    }

    const { type, market } = parsed.data;
    if (type === 'unsubscribe') {
      client.markets.delete(market);
      return;
    }

    client.markets.add(market);
    this.send(client, { type: 'ticker', ticker: this.ctx.prices.getTicker(market) });
    this.send(client, { type: 'book', book: this.ctx.orderService.bookSnapshot(market) });
    try {
      const trades = await recentTrades(this.ctx.pool, market, RECENT_TRADES_LIMIT);
      this.send(client, { type: 'trades', market, trades });
    } catch (error) {
      console.error('[ws] failed to load recent trades:', error);
      this.send(client, { type: 'error', message: 'Could not load recent trades' });
    }
  }

  private send(client: Client, message: ServerMessage): void {
    if (client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify(message));
  }

  /** Serialize once, send to every subscriber of the market. */
  private broadcast(market: MarketSymbol, message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.markets.has(market) && client.socket.readyState === WebSocket.OPEN) {
        client.socket.send(payload);
      }
    }
  }

  private sendToUser(userId: string, message: ServerMessage): void {
    for (const client of this.clients) {
      if (client.userId === userId) this.send(client, message);
    }
  }

  private async pushBalances(userIds: string[]): Promise<void> {
    const online = userIds.filter((id) => [...this.clients].some((client) => client.userId === id));
    if (online.length === 0) return;
    try {
      const balancesByUser = await listBalancesForUsers(this.ctx.pool, online);
      for (const [userId, balances] of balancesByUser) {
        this.sendToUser(userId, { type: 'balances', balances: balances.map(toBalanceDto) });
      }
    } catch (error) {
      console.error('[ws] failed to push balances:', error);
    }
  }

  private flush(): void {
    for (const market of this.dirtyBooks) {
      this.broadcast(market, { type: 'book', book: this.ctx.orderService.bookSnapshot(market) });
    }
    for (const market of this.dirtyTickers) {
      this.broadcast(market, { type: 'ticker', ticker: this.ctx.prices.getTicker(market) });
    }
    this.dirtyBooks.clear();
    this.dirtyTickers.clear();
  }

  /** Drop connections that stopped answering pings (closed laptop lids, dead Wi-Fi). */
  private checkHeartbeats(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        client.socket.terminate();
        this.clients.delete(client);
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }

  private disconnectSession(sessionHash: string): void {
    for (const client of this.clients) {
      if (client.sessionHash === sessionHash) client.socket.close(4001, 'Logged out');
    }
  }
}
