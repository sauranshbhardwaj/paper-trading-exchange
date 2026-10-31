import {
  formatUnits,
  PRICE_DECIMALS,
  QTY_DECIMALS,
  type CancelReason,
  type MarketSymbol,
  type OrderDto,
  type OrderSide,
  type OrderStatus,
  type OrderType,
} from '@pte/shared';
import type { PoolClient, Queryable } from '../db/pool.ts';
import type { MakerUpdate } from '../engine/settlement.ts';

export interface OrderRecord {
  id: string;
  userId: string;
  market: MarketSymbol;
  side: OrderSide;
  type: OrderType;
  price: bigint;
  quantity: bigint;
  filledQuantity: bigint;
  status: OrderStatus;
  cancelReason: CancelReason | null;
  createdAt: Date;
  updatedAt: Date;
}

interface OrderRow {
  id: string;
  user_id: string;
  market: MarketSymbol;
  side: OrderSide;
  type: OrderType;
  price: string;
  quantity: string;
  filled_quantity: string;
  status: OrderStatus;
  cancel_reason: CancelReason | null;
  created_at: Date;
  updated_at: Date;
}

function toOrder(row: OrderRow): OrderRecord {
  return {
    id: row.id,
    userId: row.user_id,
    market: row.market,
    side: row.side,
    type: row.type,
    price: BigInt(row.price),
    quantity: BigInt(row.quantity),
    filledQuantity: BigInt(row.filled_quantity),
    status: row.status,
    cancelReason: row.cancel_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toOrderDto(order: OrderRecord): OrderDto {
  return {
    id: order.id,
    market: order.market,
    side: order.side,
    type: order.type,
    price: formatUnits(order.price, PRICE_DECIMALS),
    quantity: formatUnits(order.quantity, QTY_DECIMALS),
    filledQuantity: formatUnits(order.filledQuantity, QTY_DECIMALS),
    status: order.status,
    cancelReason: order.cancelReason,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}

export function remainingOf(order: OrderRecord): bigint {
  return order.quantity - order.filledQuantity;
}

export async function insertOrder(
  client: PoolClient,
  order: {
    userId: string;
    market: MarketSymbol;
    side: OrderSide;
    type: OrderType;
    price: bigint;
    quantity: bigint;
  },
): Promise<OrderRecord> {
  const { rows } = await client.query<OrderRow>(
    `INSERT INTO orders (user_id, market, side, type, price, quantity, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'open')
     RETURNING *`,
    [
      order.userId,
      order.market,
      order.side,
      order.type,
      String(order.price),
      String(order.quantity),
    ],
  );
  return toOrder(rows[0]!);
}

export async function finalizeTakerOrder(
  client: PoolClient,
  orderId: string,
  filledQuantity: bigint,
  status: OrderStatus,
  cancelReason: CancelReason | null,
): Promise<OrderRecord> {
  const { rows } = await client.query<OrderRow>(
    `UPDATE orders
        SET filled_quantity = $2, status = $3, cancel_reason = $4, updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [orderId, String(filledQuantity), status, cancelReason],
  );
  return toOrder(rows[0]!);
}

/**
 * Record fills on resting orders in one statement. If memory and the database
 * ever disagree about what's left, the orders table's CHECK constraints fail
 * and the whole trade rolls back instead of saving a corrupt state.
 */
export async function applyMakerFills(
  client: PoolClient,
  updates: MakerUpdate[],
): Promise<OrderRecord[]> {
  if (updates.length === 0) return [];
  const { rows } = await client.query<OrderRow>(
    `UPDATE orders o
        SET filled_quantity = o.filled_quantity + u.filled,
            status = CASE WHEN u.remaining = 0 THEN 'filled' ELSE 'open' END,
            updated_at = now()
       FROM unnest($1::bigint[], $2::bigint[], $3::bigint[]) AS u(id, filled, remaining)
      WHERE o.id = u.id AND o.status = 'open'
      RETURNING o.*`,
    [
      updates.map((update) => update.orderId),
      updates.map((update) => String(update.filled)),
      updates.map((update) => String(update.remainingAfter)),
    ],
  );
  if (rows.length !== updates.length) {
    throw new Error(`Expected to fill ${updates.length} resting orders, updated ${rows.length}`);
  }
  return rows.map(toOrder);
}

export async function markCancelled(
  client: PoolClient,
  orderId: string,
  reason: CancelReason,
): Promise<OrderRecord> {
  const { rows } = await client.query<OrderRow>(
    `UPDATE orders SET status = 'cancelled', cancel_reason = $2, updated_at = now()
      WHERE id = $1 AND status = 'open'
      RETURNING *`,
    [orderId, reason],
  );
  if (!rows[0]) throw new Error(`Order ${orderId} was not open`);
  return toOrder(rows[0]);
}

export async function findOrderForUser(
  db: Queryable,
  orderId: string,
  userId: string,
  options: { forUpdate?: boolean } = {},
): Promise<OrderRecord | null> {
  const { rows } = await db.query<OrderRow>(
    `SELECT * FROM orders WHERE id = $1 AND user_id = $2 ${options.forUpdate ? 'FOR UPDATE' : ''}`,
    [orderId, userId],
  );
  return rows[0] ? toOrder(rows[0]) : null;
}

export async function listOrdersForUser(
  db: Queryable,
  userId: string,
  filter: {
    status?: 'open' | 'closed' | undefined;
    market?: MarketSymbol | undefined;
    limit: number;
  },
): Promise<OrderRecord[]> {
  const statusClause =
    filter.status === 'open'
      ? `AND status = 'open'`
      : filter.status === 'closed'
        ? `AND status <> 'open'`
        : '';
  const { rows } = await db.query<OrderRow>(
    `SELECT * FROM orders
      WHERE user_id = $1 ${statusClause} AND ($2::text IS NULL OR market = $2)
      ORDER BY id DESC
      LIMIT $3`,
    [userId, filter.market ?? null, filter.limit],
  );
  return rows.map(toOrder);
}

/** Open orders oldest-first: exactly the time priority the book needs on restart. */
export async function listOpenOrders(db: Queryable, market: MarketSymbol): Promise<OrderRecord[]> {
  const { rows } = await db.query<OrderRow>(
    `SELECT * FROM orders WHERE market = $1 AND status = 'open' ORDER BY id`,
    [market],
  );
  return rows.map(toOrder);
}
