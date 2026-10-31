/**
 * In-process event bus. The order service announces what happened (after the
 * database commit); the realtime hub decides who needs to hear about it.
 * Neither knows about the other.
 */
import { EventEmitter } from 'node:events';
import type { FillDto, MarketSymbol, OrderDto, TradeDto } from '@pte/shared';

export interface ExchangeEventMap {
  trade: [trade: TradeDto];
  orderUpdated: [userId: string, order: OrderDto];
  fill: [userId: string, fill: FillDto];
  balancesChanged: [userIds: string[]];
  bookChanged: [market: MarketSymbol];
  sessionEnded: [sessionHash: string];
}

export class ExchangeEvents extends EventEmitter<ExchangeEventMap> {}
