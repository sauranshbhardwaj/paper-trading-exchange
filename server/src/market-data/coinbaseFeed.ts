/**
 * Live BTC/ETH prices from Coinbase Advanced Trade's public WebSocket (no API
 * key needed for market data). Reconnects with exponential backoff and kills
 * connections that go silent, because a "connected" socket can still be dead.
 */
import WebSocket from 'ws';
import { z } from 'zod';
import {
  isDecimalString,
  isMarketSymbol,
  MARKET_SYMBOLS,
  parseUnits,
  PRICE_DECIMALS,
} from '@pte/shared';
import type { PriceBoard, PriceFeed } from './priceBoard.ts';

export const COINBASE_WS_URL = 'wss://advanced-trade-ws.coinbase.com';
const MAX_RECONNECT_DELAY_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 10_000;
// Heartbeats arrive every second, so 30s of silence means the connection is dead.
const SILENCE_LIMIT_MS = 30_000;

const tickerMessageSchema = z.object({
  channel: z.literal('ticker'),
  events: z.array(
    z.object({
      tickers: z.array(z.object({ product_id: z.string(), price: z.string() })).default([]),
    }),
  ),
});

const heartbeatMessageSchema = z.object({ channel: z.literal('heartbeats') });

export class CoinbaseFeed implements PriceFeed {
  private readonly board: PriceBoard;
  private readonly url: string;
  private socket: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private lastMessageAt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;

  constructor(board: PriceBoard, url: string = COINBASE_WS_URL) {
    this.board = board;
    this.url = url;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    this.watchdogTimer = setInterval(() => this.checkForSilence(), WATCHDOG_INTERVAL_MS);
    this.watchdogTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.socket?.close();
    this.socket = null;
  }

  /** Parse one raw message from Coinbase. Public so it can be unit tested without a network. */
  handleMessage(raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    const ticker = tickerMessageSchema.safeParse(message);
    if (ticker.success) {
      for (const event of ticker.data.events) {
        for (const { product_id: product, price } of event.tickers) {
          if (isMarketSymbol(product) && isDecimalString(price)) {
            this.board.set(product, parseUnits(price, PRICE_DECIMALS, 'truncate'));
          }
        }
      }
      return;
    }

    if (heartbeatMessageSchema.safeParse(message).success) {
      this.board.confirmAll();
    }
  }

  private connect(): void {
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.on('open', () => {
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      console.log('[coinbase] connected');
      for (const channel of ['ticker', 'heartbeats']) {
        socket.send(JSON.stringify({ type: 'subscribe', product_ids: MARKET_SYMBOLS, channel }));
      }
    });

    socket.on('message', (data) => {
      this.lastMessageAt = Date.now();
      this.handleMessage(data.toString());
    });

    // 'close' always follows 'error', so reconnecting is handled in one place.
    socket.on('error', (error) => console.warn('[coinbase] connection error:', error.message));
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    const delay = Math.min(1_000 * 2 ** this.attempt, MAX_RECONNECT_DELAY_MS);
    this.attempt += 1;
    console.warn(`[coinbase] disconnected; reconnecting in ${delay / 1000}s`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectTimer.unref();
  }

  private checkForSilence(): void {
    const socket = this.socket;
    if (
      socket?.readyState === WebSocket.OPEN &&
      Date.now() - this.lastMessageAt > SILENCE_LIMIT_MS
    ) {
      console.warn('[coinbase] no messages for 30s; forcing reconnect');
      socket.terminate();
    }
  }
}
