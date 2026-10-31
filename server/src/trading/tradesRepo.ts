import {
  formatUnits,
  PRICE_DECIMALS,
  QTY_DECIMALS,
  type MarketSymbol,
  type OrderSide,
  type TradeDto,
} from '@pte/shared';
import type { PoolClient, Queryable } from '../db/pool.ts';
import type { TradeRecord } from '../engine/settlement.ts';

export interface StoredTrade extends TradeRecord {
  id: string;
  market: MarketSymbol;
  createdAt: Date;
}

interface TradeRow {
  id: string;
  market: MarketSymbol;
  price: string;
  quantity: string;
  maker_order_id: string;
  taker_order_id: string;
  buyer_id: string;
  seller_id: string;
  taker_side: OrderSide;
  created_at: Date;
}

function toTrade(row: TradeRow): StoredTrade {
  return {
    id: row.id,
    market: row.market,
    price: BigInt(row.price),
    quantity: BigInt(row.quantity),
    makerOrderId: row.maker_order_id,
    takerOrderId: row.taker_order_id,
    buyerId: row.buyer_id,
    sellerId: row.seller_id,
    takerSide: row.taker_side,
    createdAt: row.created_at,
  };
}

/** Public view of a trade: no user ids or order ids, so nobody can track other traders. */
export function toTradeDto(trade: StoredTrade): TradeDto {
  return {
    id: trade.id,
    market: trade.market,
    price: formatUnits(trade.price, PRICE_DECIMALS),
    quantity: formatUnits(trade.quantity, QTY_DECIMALS),
    takerSide: trade.takerSide,
    createdAt: trade.createdAt.toISOString(),
  };
}

export async function insertTrades(
  client: PoolClient,
  market: MarketSymbol,
  trades: TradeRecord[],
): Promise<StoredTrade[]> {
  if (trades.length === 0) return [];
  const { rows } = await client.query<TradeRow>(
    `INSERT INTO trades (market, price, quantity, maker_order_id, taker_order_id, buyer_id, seller_id, taker_side)
     SELECT $1, t.price, t.quantity, t.maker_order_id, t.taker_order_id, t.buyer_id, t.seller_id, t.taker_side
       FROM unnest($2::bigint[], $3::bigint[], $4::bigint[], $5::bigint[], $6::bigint[], $7::bigint[], $8::text[])
         WITH ORDINALITY AS t(price, quantity, maker_order_id, taker_order_id, buyer_id, seller_id, taker_side, n)
      ORDER BY t.n
     RETURNING *`,
    [
      market,
      trades.map((trade) => String(trade.price)),
      trades.map((trade) => String(trade.quantity)),
      trades.map((trade) => trade.makerOrderId),
      trades.map((trade) => trade.takerOrderId),
      trades.map((trade) => trade.buyerId),
      trades.map((trade) => trade.sellerId),
      trades.map((trade) => trade.takerSide),
    ],
  );
  // Identity values follow insertion order, so sorting by id restores fill order.
  return rows.map(toTrade).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

export async function recentTrades(
  db: Queryable,
  market: MarketSymbol,
  limit: number,
): Promise<TradeDto[]> {
  const { rows } = await db.query<TradeRow>(
    'SELECT * FROM trades WHERE market = $1 ORDER BY id DESC LIMIT $2',
    [market, limit],
  );
  return rows.map((row) => toTradeDto(toTrade(row)));
}
