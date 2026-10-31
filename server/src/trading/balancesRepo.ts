import {
  ASSET_DECIMALS,
  ASSETS,
  formatUnits,
  STARTING_CASH,
  type Asset,
  type BalanceDto,
} from '@pte/shared';
import type { PoolClient, Queryable } from '../db/pool.ts';
import type { BalanceDelta, BalanceKey } from '../engine/settlement.ts';

export interface Balance {
  userId: string;
  asset: Asset;
  available: bigint;
  held: bigint;
}

interface BalanceRow {
  user_id: string;
  asset: Asset;
  available: string; // pg returns BIGINT as a string so no precision is lost
  held: string;
}

function toBalance(row: BalanceRow): Balance {
  return {
    userId: row.user_id,
    asset: row.asset,
    available: BigInt(row.available),
    held: BigInt(row.held),
  };
}

export function toBalanceDto(balance: Balance): BalanceDto {
  const decimals = ASSET_DECIMALS[balance.asset];
  return {
    asset: balance.asset,
    available: formatUnits(balance.available, decimals),
    held: formatUnits(balance.held, decimals),
  };
}

// USD first, then coins, in a stable order.
const ORDER_BY_ASSET = `array_position(ARRAY['USD','BTC','ETH']::text[], asset)`;

export async function createStartingBalances(
  db: Queryable,
  userId: string,
  amounts: Partial<Record<Asset, bigint>> = { USD: STARTING_CASH },
): Promise<void> {
  await db.query(
    `INSERT INTO balances (user_id, asset, available, held)
     SELECT $1, asset, available, 0
       FROM unnest($2::text[], $3::bigint[]) AS t(asset, available)`,
    [userId, [...ASSETS], ASSETS.map((asset) => String(amounts[asset] ?? 0n))],
  );
}

/**
 * SELECT ... FOR UPDATE on every balance row a trade will touch, in a single
 * statement sorted by (user_id, asset). Every transaction locks rows in the
 * same global order, so two concurrent trades can never deadlock each other.
 */
export async function lockBalances(client: PoolClient, keys: BalanceKey[]): Promise<Balance[]> {
  if (keys.length === 0) return [];
  const { rows } = await client.query<BalanceRow>(
    `SELECT b.user_id, b.asset, b.available, b.held
       FROM balances b
       JOIN unnest($1::bigint[], $2::text[]) AS k(user_id, asset)
         ON b.user_id = k.user_id AND b.asset = k.asset
      ORDER BY b.user_id, b.asset
        FOR UPDATE OF b`,
    [keys.map((key) => key.userId), keys.map((key) => key.asset)],
  );
  if (rows.length !== keys.length) {
    throw new Error(`Expected ${keys.length} balance rows but found ${rows.length}`);
  }
  return rows.map(toBalance);
}

/** Apply all deltas in one statement. CHECK constraints reject any negative result. */
export async function applyBalanceDeltas(
  client: PoolClient,
  deltas: BalanceDelta[],
): Promise<void> {
  if (deltas.length === 0) return;
  const result = await client.query(
    `UPDATE balances b
        SET available = b.available + d.available,
            held      = b.held + d.held
       FROM unnest($1::bigint[], $2::text[], $3::bigint[], $4::bigint[]) AS d(user_id, asset, available, held)
      WHERE b.user_id = d.user_id AND b.asset = d.asset`,
    [
      deltas.map((delta) => delta.userId),
      deltas.map((delta) => delta.asset),
      deltas.map((delta) => String(delta.available)),
      deltas.map((delta) => String(delta.held)),
    ],
  );
  if (result.rowCount !== deltas.length) {
    throw new Error(`Expected to update ${deltas.length} balance rows, updated ${result.rowCount}`);
  }
}

export async function listBalances(db: Queryable, userId: string): Promise<Balance[]> {
  const { rows } = await db.query<BalanceRow>(
    `SELECT user_id, asset, available, held FROM balances WHERE user_id = $1 ORDER BY ${ORDER_BY_ASSET}`,
    [userId],
  );
  return rows.map(toBalance);
}

export async function listBalancesForUsers(
  db: Queryable,
  userIds: string[],
): Promise<Map<string, Balance[]>> {
  const byUser = new Map<string, Balance[]>();
  if (userIds.length === 0) return byUser;
  const { rows } = await db.query<BalanceRow>(
    `SELECT user_id, asset, available, held FROM balances
      WHERE user_id = ANY($1::bigint[])
      ORDER BY user_id, ${ORDER_BY_ASSET}`,
    [userIds],
  );
  for (const row of rows) {
    const balance = toBalance(row);
    byUser.set(balance.userId, [...(byUser.get(balance.userId) ?? []), balance]);
  }
  return byUser;
}
