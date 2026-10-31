/**
 * Turns a match result into balance changes, trade records and order updates.
 * Pure functions only — the order service writes the output to Postgres.
 *
 * The one invariant everything relies on:
 *   an open order always holds exactly holdAmountFor(side, limitPrice, remaining)
 * (cash at the limit price for buys, the coins themselves for sells).
 */
import {
  holdAmountFor,
  holdAssetFor,
  notional,
  type Asset,
  type CancelReason,
  type MarketConfig,
  type OrderSide,
  type OrderStatus,
} from '@pte/shared';
import type { MatchOutcome, MatchResult } from './orderBook.ts';

export interface BalanceDelta {
  userId: string;
  asset: Asset;
  available: bigint;
  held: bigint;
}

export interface BalanceKey {
  userId: string;
  asset: Asset;
}

/** Accumulates balance changes per (user, asset) so each row is written once. */
export class BalanceDeltas {
  private readonly deltas = new Map<string, BalanceDelta>();

  add(userId: string, asset: Asset, change: { available?: bigint; held?: bigint }): void {
    const key = `${userId}:${asset}`;
    const delta = this.deltas.get(key) ?? { userId, asset, available: 0n, held: 0n };
    delta.available += change.available ?? 0n;
    delta.held += change.held ?? 0n;
    this.deltas.set(key, delta);
  }

  /** Lock funds: available -> held. */
  hold(userId: string, asset: Asset, amount: bigint): void {
    this.add(userId, asset, { available: -amount, held: amount });
  }

  /** Unlock funds: held -> available. */
  release(userId: string, asset: Asset, amount: bigint): void {
    this.add(userId, asset, { available: amount, held: -amount });
  }

  get(userId: string, asset: Asset): BalanceDelta | undefined {
    const delta = this.deltas.get(`${userId}:${asset}`);
    return delta ? { ...delta } : undefined;
  }

  /** Sorted by user id then asset, for deterministic output. */
  list(): BalanceDelta[] {
    return [...this.deltas.values()]
      .map((delta) => ({ ...delta }))
      .sort((a, b) => compareUserIds(a.userId, b.userId) || a.asset.localeCompare(b.asset));
  }

  keys(): BalanceKey[] {
    return this.list().map(({ userId, asset }) => ({ userId, asset }));
  }

  userIds(): string[] {
    return [...new Set(this.list().map((delta) => delta.userId))];
  }
}

function compareUserIds(a: string, b: string): number {
  const difference = BigInt(a) - BigInt(b);
  return difference === 0n ? 0 : difference < 0n ? -1 : 1;
}

export interface TakerOrder {
  id: string;
  userId: string;
  side: OrderSide;
  limitPrice: bigint;
  quantity: bigint;
}

export interface TradeRecord {
  makerOrderId: string;
  takerOrderId: string;
  buyerId: string;
  sellerId: string;
  price: bigint;
  quantity: bigint;
  takerSide: OrderSide;
}

export interface MakerUpdate {
  orderId: string;
  userId: string;
  /** Quantity filled in this match (add to filled_quantity). */
  filled: bigint;
  remainingAfter: bigint;
}

export interface Settlement {
  deltas: BalanceDeltas;
  trades: TradeRecord[];
  makerUpdates: MakerUpdate[];
  takerFilled: bigint;
  takerStatus: OrderStatus;
  takerCancelReason: CancelReason | null;
}

export function takerFinalState(outcome: MatchOutcome): {
  status: OrderStatus;
  cancelReason: CancelReason | null;
} {
  switch (outcome) {
    case 'filled':
      return { status: 'filled', cancelReason: null };
    case 'resting':
      return { status: 'open', cancelReason: null };
    case 'expired':
      return { status: 'cancelled', cancelReason: 'unfilled_remainder' };
    case 'self_trade_prevented':
      return { status: 'cancelled', cancelReason: 'self_trade_prevention' };
  }
}

/**
 * Balance changes for one fill. Buyers locked cash at their own limit price,
 * so if they trade at a better price the difference goes back to available.
 */
function settleFill(
  deltas: BalanceDeltas,
  market: MarketConfig,
  buyer: { userId: string; limitPrice: bigint },
  sellerId: string,
  price: bigint,
  quantity: bigint,
): void {
  const cost = notional(price, quantity);
  const buyerHeld = notional(buyer.limitPrice, quantity);

  deltas.add(buyer.userId, market.quote, { held: -buyerHeld, available: buyerHeld - cost });
  deltas.add(buyer.userId, market.base, { available: quantity });

  deltas.add(sellerId, market.base, { held: -quantity });
  deltas.add(sellerId, market.quote, { available: cost });
}

export function computeSettlement(
  market: MarketConfig,
  taker: TakerOrder,
  result: MatchResult,
): Settlement {
  const deltas = new BalanceDeltas();
  const holdAsset = holdAssetFor(market, taker.side);

  // 1. Lock the taker's funds for the whole order.
  deltas.hold(taker.userId, holdAsset, holdAmountFor(taker.side, taker.limitPrice, taker.quantity));

  // 2. Settle every fill.
  const trades: TradeRecord[] = [];
  const makerUpdates: MakerUpdate[] = [];
  for (const fill of result.fills) {
    const takerIsBuyer = taker.side === 'buy';
    // A resting buyer always trades at its own limit price, so its "limit" is the fill price.
    const buyer = takerIsBuyer
      ? { userId: taker.userId, limitPrice: taker.limitPrice }
      : { userId: fill.makerUserId, limitPrice: fill.price };
    const sellerId = takerIsBuyer ? fill.makerUserId : taker.userId;

    settleFill(deltas, market, buyer, sellerId, fill.price, fill.quantity);

    trades.push({
      makerOrderId: fill.makerOrderId,
      takerOrderId: taker.id,
      buyerId: buyer.userId,
      sellerId,
      price: fill.price,
      quantity: fill.quantity,
      takerSide: taker.side,
    });
    makerUpdates.push({
      orderId: fill.makerOrderId,
      userId: fill.makerUserId,
      filled: fill.quantity,
      remainingAfter: fill.makerRemainingAfter,
    });
  }

  // 3. Anything that won't rest on the book gives its lock back.
  const { status, cancelReason } = takerFinalState(result.outcome);
  if (status === 'cancelled') {
    deltas.release(
      taker.userId,
      holdAsset,
      holdAmountFor(taker.side, taker.limitPrice, result.remaining),
    );
  }

  return {
    deltas,
    trades,
    makerUpdates,
    takerFilled: taker.quantity - result.remaining,
    takerStatus: status,
    takerCancelReason: cancelReason,
  };
}

/** Balance changes for cancelling an open order: release whatever it still holds. */
export function computeCancellation(
  market: MarketConfig,
  order: { userId: string; side: OrderSide; limitPrice: bigint; remaining: bigint },
): BalanceDeltas {
  const deltas = new BalanceDeltas();
  deltas.release(
    order.userId,
    holdAssetFor(market, order.side),
    holdAmountFor(order.side, order.limitPrice, order.remaining),
  );
  return deltas;
}
