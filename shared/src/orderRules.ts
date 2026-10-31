/**
 * Order rules shared by the server (authoritative) and the client (instant
 * form feedback). Keeping one copy means the UI can never disagree with the
 * server about what a valid order is.
 */
import { formatCash, formatPrice, formatQty } from './format.ts';
import {
  MARKET_ORDER_PROTECTION_BPS,
  PRICE_BAND_BPS,
  type Asset,
  type MarketConfig,
  type MarketSymbol,
} from './markets.ts';
import { notional, scaleByBps } from './money.ts';

export const ORDER_SIDES = ['buy', 'sell'] as const;
export type OrderSide = (typeof ORDER_SIDES)[number];
export const ORDER_TYPES = ['limit', 'market'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

/** GTC = rests on the book until filled or cancelled. IOC = fill what you can now, cancel the rest. */
export type TimeInForce = 'GTC' | 'IOC';

export interface OrderRequest {
  market: MarketSymbol;
  side: OrderSide;
  type: OrderType;
  /** Price units. Required for limit orders, ignored for market orders. */
  price?: bigint | undefined;
  /** Quantity units. */
  quantity: bigint;
}

export interface ResolvedOrder {
  /** Worst price this order may trade at. For market orders it's the slippage-protection price. */
  limitPrice: bigint;
  timeInForce: TimeInForce;
  holdAsset: Asset;
  /** Amount of holdAsset locked while the order is open, so it can't be spent twice. */
  holdAmount: bigint;
}

export type OrderRuleCode =
  | 'INVALID_QUANTITY'
  | 'INVALID_PRICE'
  | 'PRICE_OUT_OF_BAND'
  | 'BELOW_MIN_NOTIONAL'
  | 'MARKET_DATA_UNAVAILABLE';

export class OrderRuleError extends Error {
  readonly code: OrderRuleCode;

  constructor(code: OrderRuleCode, message: string) {
    super(message);
    this.name = 'OrderRuleError';
    this.code = code;
  }
}

export interface PriceRange {
  min: bigint;
  max: bigint;
}

/** Prices within ±bps of the reference. Rounded inward so the band never exceeds the limit. */
export function priceBand(referencePrice: bigint, bps: number = PRICE_BAND_BPS): PriceRange {
  return {
    min: scaleByBps(referencePrice, 10_000 - bps, 'ceil'),
    max: scaleByBps(referencePrice, 10_000 + bps, 'floor'),
  };
}

/** A market buy is treated as "buy at up to +5%", a market sell as "sell at down to -5%". */
export function marketProtectionPrice(side: OrderSide, referencePrice: bigint): bigint {
  const band = priceBand(referencePrice, MARKET_ORDER_PROTECTION_BPS);
  return side === 'buy' ? band.max : band.min;
}

/**
 * What must be locked for `quantity` of an order. Buys lock cash at their
 * limit price; sells lock the coins themselves. Settlement relies on this
 * invariant: an open order always holds exactly holdAmountFor(remaining).
 */
export function holdAmountFor(side: OrderSide, limitPrice: bigint, quantity: bigint): bigint {
  return side === 'buy' ? notional(limitPrice, quantity) : quantity;
}

export function holdAssetFor(market: MarketConfig, side: OrderSide): Asset {
  return side === 'buy' ? market.quote : market.base;
}

/**
 * Validate an order against market rules and the live reference price, and
 * work out what it should lock. Throws OrderRuleError with a user-facing message.
 */
export function resolveOrder(
  market: MarketConfig,
  request: OrderRequest,
  referencePrice: bigint | null,
): ResolvedOrder {
  const { side, type, quantity } = request;

  if (quantity <= 0n || quantity % market.qtyStep !== 0n) {
    throw new OrderRuleError(
      'INVALID_QUANTITY',
      `Quantity must be a multiple of ${formatQty(market.qtyStep, market.qtyDisplayDecimals)} ${market.base}`,
    );
  }

  if (referencePrice === null) {
    throw new OrderRuleError(
      'MARKET_DATA_UNAVAILABLE',
      'The live price feed is unavailable, so trading is paused. Try again in a moment.',
    );
  }

  let limitPrice: bigint;
  if (type === 'limit') {
    const price = request.price;
    if (price === undefined || price <= 0n) {
      throw new OrderRuleError('INVALID_PRICE', 'Limit orders need a price greater than $0');
    }
    const band = priceBand(referencePrice);
    if (price < band.min || price > band.max) {
      throw new OrderRuleError(
        'PRICE_OUT_OF_BAND',
        `Price must be within ${PRICE_BAND_BPS / 100}% of the live price (${formatPrice(band.min)} – ${formatPrice(band.max)})`,
      );
    }
    limitPrice = price;
  } else {
    limitPrice = marketProtectionPrice(side, referencePrice);
  }

  // Market orders don't have a price of their own, so size them at the reference price.
  const valuationPrice = type === 'limit' ? limitPrice : referencePrice;
  if (notional(valuationPrice, quantity) < market.minNotional) {
    throw new OrderRuleError(
      'BELOW_MIN_NOTIONAL',
      `Order value must be at least ${formatCash(market.minNotional)}`,
    );
  }

  return {
    limitPrice,
    timeInForce: type === 'limit' ? 'GTC' : 'IOC',
    holdAsset: holdAssetFor(market, side),
    holdAmount: holdAmountFor(side, limitPrice, quantity),
  };
}
