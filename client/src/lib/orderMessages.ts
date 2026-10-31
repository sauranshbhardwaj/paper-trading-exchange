/** User-facing wording for order outcomes. Pure, so it's tested and reused. */
import { MARKET_ORDER_PROTECTION_BPS, MARKETS, type OrderDto } from '@pte/shared';
import type { ToastVariant } from '../context/ToastContext.tsx';
import { displayPrice, displayQty, qtyUnits } from './format.ts';

export function statusLabel(order: OrderDto): string {
  if (order.status === 'open') return qtyUnits(order.filledQuantity) > 0n ? 'Partial' : 'Open';
  if (order.status === 'filled') return 'Filled';
  switch (order.cancelReason) {
    case 'self_trade_prevention':
      return 'Self-trade prevented';
    case 'unfilled_remainder':
      return qtyUnits(order.filledQuantity) > 0n ? 'Partially filled' : 'Expired';
    default:
      return 'Cancelled';
  }
}

export interface OrderToast {
  variant: ToastVariant;
  title: string;
  body: string;
}

/** What to tell the user right after they submit an order. */
export function orderResultToast(order: OrderDto): OrderToast {
  const base = MARKETS[order.market].base;
  const filled = `${displayQty(order.filledQuantity, order.market)} ${base}`;
  const total = `${displayQty(order.quantity, order.market)} ${base}`;
  const verb = order.side === 'buy' ? 'Bought' : 'Sold';
  const hasFills = qtyUnits(order.filledQuantity) > 0n;

  if (order.status === 'filled') {
    return { variant: 'success', title: `${verb} ${total}`, body: 'Your order filled completely.' };
  }
  if (order.status === 'open') {
    return {
      variant: 'info',
      title: hasFills ? `${verb} ${filled}` : 'Order placed',
      body: hasFills
        ? `The rest is waiting on the book at ${displayPrice(order.price)}.`
        : `${order.side === 'buy' ? 'Buy' : 'Sell'} ${total} at ${displayPrice(order.price)} is on the book.`,
    };
  }
  if (order.cancelReason === 'self_trade_prevention') {
    return {
      variant: 'warning',
      title: hasFills ? `${verb} ${filled}, rest cancelled` : 'Order cancelled',
      body: 'It would have traded against your own resting order.',
    };
  }
  return {
    variant: hasFills ? 'warning' : 'danger',
    title: hasFills ? `${verb} ${filled} of ${total}` : 'Market order not filled',
    body: `Not enough liquidity within ${MARKET_ORDER_PROTECTION_BPS / 100}% of the live price. Nothing else was reserved.`,
  };
}
