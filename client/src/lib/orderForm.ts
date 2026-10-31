/**
 * Order form maths, kept out of React so it can be unit tested. Validation
 * reuses the shared schema and rules, so the form agrees with the server.
 */
import {
  formatUnits,
  marketProtectionPrice,
  notional,
  OrderRuleError,
  placeOrderSchema,
  QTY_DECIMALS,
  resolveOrder,
  type MarketConfig,
  type OrderSide,
  type OrderType,
} from '@pte/shared';

export interface OrderFormValues {
  side: OrderSide;
  type: OrderType;
  price: string;
  quantity: string;
}

export interface OrderPreview {
  /** Estimated order value in cash units (exact for limit, at reference price for market). */
  total: bigint | null;
  /** What will be locked when the order is placed. */
  reserve: bigint | null;
  /** First problem with the form, worded for the user. */
  error: string | null;
}

export function floorToStep(value: bigint, step: bigint): bigint {
  return value - (value % step);
}

/**
 * Largest quantity the user can afford. Buys divide cash by the price they'd
 * reserve at (the protection price for market buys); sells use coins owned.
 */
export function maxQuantity(
  market: MarketConfig,
  form: Pick<OrderFormValues, 'side' | 'type'>,
  available: bigint,
  limitPrice: bigint | null,
  referencePrice: bigint | null,
): bigint {
  if (form.side === 'sell') return floorToStep(available, market.qtyStep);
  const price =
    form.type === 'market'
      ? referencePrice === null
        ? null
        : marketProtectionPrice('buy', referencePrice)
      : limitPrice;
  if (price === null || price <= 0n) return 0n;
  // cash units ÷ price units = quantity units
  return floorToStep(available / price, market.qtyStep);
}

/** e.g. 50% of the max, rounded down to the market's step, as an input string. */
export function fractionOfMax(max: bigint, percent: number, step: bigint): string {
  const quantity = floorToStep((max * BigInt(percent)) / 100n, step);
  return quantity > 0n ? formatUnits(quantity, QTY_DECIMALS) : '';
}

export function previewOrder(
  market: MarketConfig,
  form: OrderFormValues,
  referencePrice: bigint | null,
): OrderPreview {
  const parsed = placeOrderSchema.safeParse(
    form.type === 'limit'
      ? {
          type: 'limit',
          market: market.symbol,
          side: form.side,
          price: form.price,
          quantity: form.quantity,
        }
      : { type: 'market', market: market.symbol, side: form.side, quantity: form.quantity },
  );
  if (!parsed.success) {
    return {
      total: null,
      reserve: null,
      error: parsed.error.issues[0]?.message ?? 'Invalid order',
    };
  }

  const order = parsed.data;
  const valuationPrice = order.type === 'limit' ? order.price : referencePrice;
  const total = valuationPrice === null ? null : notional(valuationPrice, order.quantity);

  try {
    const resolved = resolveOrder(
      market,
      { ...order, price: order.type === 'limit' ? order.price : undefined },
      referencePrice,
    );
    return { total, reserve: resolved.holdAmount, error: null };
  } catch (error) {
    if (error instanceof OrderRuleError) return { total, reserve: null, error: error.message };
    throw error;
  }
}
