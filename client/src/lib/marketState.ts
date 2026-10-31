/** Pure reducer for public market data arriving over the WebSocket. */
import type { BookDto, MarketSymbol, ServerMessage, TickerDto, TradeDto } from '@pte/shared';

export const MAX_TRADES = 50;

export interface MarketState {
  market: MarketSymbol;
  book: BookDto | null;
  trades: TradeDto[];
  ticker: TickerDto | null;
}

export function initialMarketState(market: MarketSymbol): MarketState {
  return { market, book: null, trades: [], ticker: null };
}

function byIdDescending(a: TradeDto, b: TradeDto): number {
  const difference = BigInt(b.id) - BigInt(a.id);
  return difference === 0n ? 0 : difference > 0n ? 1 : -1;
}

/**
 * Union of two trade lists, newest first, no duplicates. Needed because a
 * live "trade" message can arrive before the "trades" snapshot it's part of.
 */
export function mergeTrades(current: TradeDto[], incoming: TradeDto[]): TradeDto[] {
  const byId = new Map<string, TradeDto>();
  for (const trade of [...current, ...incoming]) byId.set(trade.id, trade);
  return [...byId.values()].sort(byIdDescending).slice(0, MAX_TRADES);
}

export function marketReducer(state: MarketState, message: ServerMessage): MarketState {
  switch (message.type) {
    case 'book':
      return message.book.market === state.market ? { ...state, book: message.book } : state;
    case 'trades':
      return message.market === state.market
        ? { ...state, trades: mergeTrades(state.trades, message.trades) }
        : state;
    case 'trade':
      return message.trade.market === state.market
        ? { ...state, trades: mergeTrades(state.trades, [message.trade]) }
        : state;
    case 'ticker':
      return message.ticker.market === state.market ? { ...state, ticker: message.ticker } : state;
    default:
      return state;
  }
}
