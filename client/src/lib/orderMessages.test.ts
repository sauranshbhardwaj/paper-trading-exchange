import { describe, expect, it } from 'vitest';
import type { OrderDto } from '@pte/shared';
import { orderResultToast, statusLabel } from './orderMessages.ts';

function order(overrides: Partial<OrderDto>): OrderDto {
  return {
    id: '1',
    market: 'BTC-USD',
    side: 'buy',
    type: 'limit',
    price: '50000',
    quantity: '0.1',
    filledQuantity: '0',
    status: 'open',
    cancelReason: null,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describe('statusLabel', () => {
  it.each([
    [{ status: 'open' }, 'Open'],
    [{ status: 'open', filledQuantity: '0.05' }, 'Partial'],
    [{ status: 'filled', filledQuantity: '0.1' }, 'Filled'],
    [{ status: 'cancelled', cancelReason: 'user' }, 'Cancelled'],
    [{ status: 'cancelled', cancelReason: 'self_trade_prevention' }, 'Self-trade prevented'],
    [{ status: 'cancelled', cancelReason: 'unfilled_remainder' }, 'Expired'],
    [
      { status: 'cancelled', cancelReason: 'unfilled_remainder', filledQuantity: '0.05' },
      'Partially filled',
    ],
  ] as const)('%j → %s', (overrides, label) => {
    expect(statusLabel(order(overrides))).toBe(label);
  });
});

describe('orderResultToast', () => {
  it('celebrates a full fill', () => {
    expect(orderResultToast(order({ status: 'filled', filledQuantity: '0.1' }))).toMatchObject({
      variant: 'success',
      title: 'Bought 0.10000 BTC',
    });
  });

  it('explains a resting order', () => {
    expect(orderResultToast(order({ side: 'sell' }))).toMatchObject({
      variant: 'info',
      title: 'Order placed',
      body: 'Sell 0.10000 BTC at $50,000.00 is on the book.',
    });
  });

  it('explains a partial fill that is still resting', () => {
    expect(orderResultToast(order({ filledQuantity: '0.04' }))).toMatchObject({
      title: 'Bought 0.04000 BTC',
      body: 'The rest is waiting on the book at $50,000.00.',
    });
  });

  it('explains self-trade prevention', () => {
    expect(
      orderResultToast(order({ status: 'cancelled', cancelReason: 'self_trade_prevention' })),
    ).toMatchObject({ variant: 'warning', title: 'Order cancelled' });
  });

  it('explains an unfilled market order', () => {
    expect(
      orderResultToast(
        order({ type: 'market', status: 'cancelled', cancelReason: 'unfilled_remainder' }),
      ),
    ).toMatchObject({ variant: 'danger', title: 'Market order not filled' });
    expect(
      orderResultToast(
        order({
          type: 'market',
          status: 'cancelled',
          cancelReason: 'unfilled_remainder',
          filledQuantity: '0.02',
        }),
      ),
    ).toMatchObject({ variant: 'warning', title: 'Bought 0.02000 BTC of 0.10000 BTC' });
  });
});
