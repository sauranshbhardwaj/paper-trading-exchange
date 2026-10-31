/**
 * One WebSocket for the whole app. Reconnects automatically with backoff and
 * re-subscribes to whatever markets are on screen. Components subscribe via
 * reference counting, so two components watching BTC-USD share one subscription.
 */
import type { ClientMessage, MarketSymbol, ServerMessage } from '@pte/shared';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';
type MessageListener = (message: ServerMessage) => void;
type StatusListener = (status: ConnectionStatus) => void;

const MAX_RECONNECT_DELAY_MS = 15_000;

export class RealtimeClient {
  private readonly url: string;
  private socket: WebSocket | null = null;
  private readonly messageListeners = new Set<MessageListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private readonly subscriptions = new Map<MarketSymbol, number>();
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentStatus: ConnectionStatus = 'closed';

  constructor(url: string) {
    this.url = url;
  }

  get status(): ConnectionStatus {
    return this.currentStatus;
  }

  /** Safe to call repeatedly (React StrictMode runs effects twice in dev): only one socket at a time. */
  connect(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    this.setStatus('connecting');

    socket.onopen = () => {
      this.attempt = 0;
      this.setStatus('open');
      for (const market of this.subscriptions.keys()) this.send({ type: 'subscribe', market });
    };
    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      for (const listener of this.messageListeners) listener(message);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return; // replaced by reconnect(); ignore the old one
      this.socket = null;
      this.setStatus('closed');
      this.scheduleReconnect();
    };
  }

  /** Drop and re-open the connection, e.g. after login/logout so the server re-reads the cookie. */
  reconnect(): void {
    const old = this.socket;
    this.socket = null;
    old?.close();
    this.connect();
  }

  subscribe(market: MarketSymbol): () => void {
    const count = this.subscriptions.get(market) ?? 0;
    this.subscriptions.set(market, count + 1);
    if (count === 0) this.send({ type: 'subscribe', market });

    return () => {
      const remaining = (this.subscriptions.get(market) ?? 1) - 1;
      if (remaining > 0) {
        this.subscriptions.set(market, remaining);
      } else {
        this.subscriptions.delete(market);
        this.send({ type: 'unsubscribe', market });
      }
    };
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private setStatus(status: ConnectionStatus): void {
    this.currentStatus = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private scheduleReconnect(): void {
    // Exponential backoff with jitter so a server restart isn't hit by every tab at once.
    const base = Math.min(1_000 * 2 ** this.attempt, MAX_RECONNECT_DELAY_MS);
    const delay = base / 2 + Math.random() * (base / 2);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

export function defaultSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/ws`;
}
