import { describe, expect, it } from 'vitest';
import {
  clientMessageSchema,
  fieldErrors,
  loginSchema,
  placeOrderSchema,
  registerSchema,
} from './schemas.ts';

describe('placeOrderSchema', () => {
  it('parses a limit order into integer units', () => {
    const parsed = placeOrderSchema.parse({
      type: 'limit',
      market: 'BTC-USD',
      side: 'buy',
      price: '77394.14',
      quantity: '0.015',
    });
    expect(parsed).toEqual({
      type: 'limit',
      market: 'BTC-USD',
      side: 'buy',
      price: 7_739_414n,
      quantity: 1_500_000n,
    });
  });

  it('parses a market order without a price', () => {
    const parsed = placeOrderSchema.parse({
      type: 'market',
      market: 'ETH-USD',
      side: 'sell',
      quantity: '1',
    });
    expect(parsed).toEqual({
      type: 'market',
      market: 'ETH-USD',
      side: 'sell',
      quantity: 100_000_000n,
    });
  });

  it.each([
    [{ price: '-5' }, 'price', 'Price must be a number like 12.5'],
    [{ price: '1.005' }, 'price', 'Price allows at most 2 decimal places'],
    [{ price: '0' }, 'price', 'Price must be greater than 0'],
    [{ price: '' }, 'price', 'Price is required'],
    [{ quantity: '0.000000001' }, 'quantity', 'Quantity allows at most 8 decimal places'],
    [{ quantity: '1e3' }, 'quantity', 'Quantity must be a number like 12.5'],
    [{ quantity: '9999999999999' }, 'quantity', 'Quantity is too large'],
    [{ market: 'DOGE-USD' }, 'market', 'Unknown market'],
    [{ side: 'hold' }, 'side', 'Side must be buy or sell'],
  ])('rejects %j', (override, field, message) => {
    const result = placeOrderSchema.safeParse({
      type: 'limit',
      market: 'BTC-USD',
      side: 'buy',
      price: '100',
      quantity: '1',
      ...override,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(fieldErrors(result.error)[field]).toBe(message);
  });

  it('rejects numbers sent as JSON numbers (floats are not allowed in)', () => {
    const result = placeOrderSchema.safeParse({
      type: 'limit',
      market: 'BTC-USD',
      side: 'buy',
      price: 100.5,
      quantity: '1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown order types', () => {
    const result = placeOrderSchema.safeParse({ type: 'stop', market: 'BTC-USD', side: 'buy' });
    expect(result.success).toBe(false);
  });
});

describe('auth schemas', () => {
  it('normalizes email case and whitespace', () => {
    const parsed = registerSchema.parse({
      email: '  Alice@Example.COM ',
      password: 'correct horse',
      displayName: ' alice_1 ',
    });
    expect(parsed.email).toBe('alice@example.com');
    expect(parsed.displayName).toBe('alice_1');
  });

  it.each([
    [{ email: 'not-an-email' }, 'email'],
    [{ password: 'short' }, 'password'],
    [{ password: 'x'.repeat(129) }, 'password'],
    [{ displayName: 'a' }, 'displayName'],
    [{ displayName: 'has spaces' }, 'displayName'],
    [{ displayName: '<script>' }, 'displayName'],
  ])('rejects invalid registration %j', (override, field) => {
    const result = registerSchema.safeParse({
      email: 'a@b.co',
      password: 'longenough',
      displayName: 'alice',
      ...override,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(fieldErrors(result.error)).toHaveProperty(field);
  });

  it('requires a password to log in', () => {
    expect(loginSchema.safeParse({ email: 'a@b.co', password: '' }).success).toBe(false);
  });
});

describe('clientMessageSchema', () => {
  it('accepts subscribe/unsubscribe for known markets only', () => {
    expect(clientMessageSchema.safeParse({ type: 'subscribe', market: 'BTC-USD' }).success).toBe(
      true,
    );
    expect(clientMessageSchema.safeParse({ type: 'subscribe', market: 'XRP-USD' }).success).toBe(
      false,
    );
    expect(clientMessageSchema.safeParse({ type: 'drop_tables' }).success).toBe(false);
  });
});
