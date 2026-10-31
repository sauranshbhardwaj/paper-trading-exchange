/**
 * Zod schemas for everything that crosses a trust boundary (HTTP bodies,
 * query strings, WebSocket messages). The server parses with these; the
 * client reuses them for form validation so error messages match.
 */
import { z } from 'zod';
import { MARKET_SYMBOLS } from './markets.ts';
import {
  countFractionDigits,
  countWholeDigits,
  isDecimalString,
  parseUnits,
  PRICE_DECIMALS,
  QTY_DECIMALS,
} from './money.ts';
import { ORDER_SIDES } from './orderRules.ts';

// 12 whole digits is far beyond any sane price or size, and keeps every
// product of price × quantity comfortably inside Postgres BIGINT.
const MAX_WHOLE_DIGITS = 12;

/** A positive decimal string like "0.015", converted to integer units. */
export function positiveDecimal(decimals: number, label: string) {
  return z
    .string({ error: `${label} is required` })
    .trim()
    .refine((value) => value !== '', `${label} is required`)
    .refine(isDecimalString, `${label} must be a number like 12.5`)
    .refine(
      (value) => countFractionDigits(value) <= decimals,
      `${label} allows at most ${decimals} decimal places`,
    )
    .refine((value) => countWholeDigits(value) <= MAX_WHOLE_DIGITS, `${label} is too large`)
    .transform((value) => parseUnits(value, decimals))
    .refine((units) => units > 0n, `${label} must be greater than 0`);
}

export const marketSymbolSchema = z.enum(MARKET_SYMBOLS, { error: 'Unknown market' });
export const orderSideSchema = z.enum(ORDER_SIDES, { error: 'Side must be buy or sell' });

const priceSchema = positiveDecimal(PRICE_DECIMALS, 'Price');
const quantitySchema = positiveDecimal(QTY_DECIMALS, 'Quantity');

export const placeOrderSchema = z.discriminatedUnion(
  'type',
  [
    z.object({
      type: z.literal('limit'),
      market: marketSymbolSchema,
      side: orderSideSchema,
      price: priceSchema,
      quantity: quantitySchema,
    }),
    z.object({
      type: z.literal('market'),
      market: marketSymbolSchema,
      side: orderSideSchema,
      quantity: quantitySchema,
    }),
  ],
  { error: 'Order type must be limit or market' },
);
export type PlaceOrderInput = z.input<typeof placeOrderSchema>;
export type PlaceOrderParsed = z.output<typeof placeOrderSchema>;

export const listOrdersQuerySchema = z.object({
  status: z.enum(['open', 'closed']).optional(),
  market: marketSymbolSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const orderIdParamSchema = z.object({
  id: z.string().regex(/^\d{1,18}$/, 'Invalid order id'),
});

const emailSchema = z
  .string({ error: 'Email is required' })
  .trim()
  .toLowerCase()
  .pipe(z.email('Enter a valid email address').max(254, 'Email is too long'));

export const registerSchema = z.object({
  email: emailSchema,
  password: z
    .string({ error: 'Password is required' })
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters'),
  displayName: z
    .string({ error: 'Display name is required' })
    .trim()
    .min(2, 'Display name must be at least 2 characters')
    .max(24, 'Display name must be at most 24 characters')
    .regex(/^[A-Za-z0-9_-]+$/, 'Use only letters, numbers, - and _'),
});
export type RegisterInput = z.input<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z
    .string({ error: 'Password is required' })
    .min(1, 'Password is required')
    .max(128, 'Password must be at most 128 characters'),
});
export type LoginInput = z.input<typeof loginSchema>;

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), market: marketSymbolSchema }),
  z.object({ type: z.literal('unsubscribe'), market: marketSymbolSchema }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

/** Flatten a ZodError into { field: firstMessage } for forms. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const result: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_';
    result[key] ??= issue.message;
  }
  return result;
}
