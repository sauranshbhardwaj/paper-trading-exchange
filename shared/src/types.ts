/**
 * Shapes sent from the server to the client. Every amount is an exact decimal
 * string (e.g. "0.015", "77394.14") — never a JS number — so nothing is lost
 * in JSON. Use parseUnits() to turn them back into BigInt units.
 */
import type { Asset, MarketSymbol } from './markets.ts';
import type { OrderSide, OrderType } from './orderRules.ts';

export type OrderStatus = 'open' | 'filled' | 'cancelled';

export type CancelReason =
  /** The user cancelled it. */
  | 'user'
  /** An immediate-or-cancel order (e.g. a market order) filled what it could; the rest expired. */
  | 'unfilled_remainder'
  /** It would have traded against the same user's own resting order. */
  | 'self_trade_prevention';

export interface UserDto {
  id: string;
  email: string;
  displayName: string;
}

export interface BalanceDto {
  asset: Asset;
  available: string;
  held: string;
}

export interface OrderDto {
  id: string;
  market: MarketSymbol;
  side: OrderSide;
  type: OrderType;
  /** Limit price. For market orders this is the slippage-protection price. */
  price: string;
  quantity: string;
  filledQuantity: string;
  status: OrderStatus;
  cancelReason: CancelReason | null;
  createdAt: string;
  updatedAt: string;
}

export interface TradeDto {
  id: string;
  market: MarketSymbol;
  price: string;
  quantity: string;
  /** Side of the incoming (aggressive) order — "buy" means a buyer lifted an ask. */
  takerSide: OrderSide;
  createdAt: string;
}

export interface FillDto {
  orderId: string;
  market: MarketSymbol;
  side: OrderSide;
  price: string;
  quantity: string;
  role: 'maker' | 'taker';
}

export interface BookLevelDto {
  price: string;
  quantity: string;
  orderCount: number;
}

export interface BookDto {
  market: MarketSymbol;
  /** Best (highest) first. */
  bids: BookLevelDto[];
  /** Best (lowest) first. */
  asks: BookLevelDto[];
}

export interface TickerDto {
  market: MarketSymbol;
  /** Latest Coinbase price, or null if we've never received one. */
  referencePrice: string | null;
  updatedAt: string | null;
  /** True when the price is too old to trade against. */
  stale: boolean;
}

export type ServerMessage =
  | { type: 'book'; book: BookDto }
  | { type: 'trades'; market: MarketSymbol; trades: TradeDto[] }
  | { type: 'trade'; trade: TradeDto }
  | { type: 'ticker'; ticker: TickerDto }
  | { type: 'order'; order: OrderDto }
  | { type: 'fill'; fill: FillDto }
  | { type: 'balances'; balances: BalanceDto[] }
  | { type: 'error'; message: string };

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
  };
}

export interface HealthDto {
  ok: boolean;
  database: boolean;
  priceFeed: Record<MarketSymbol, boolean>;
}
