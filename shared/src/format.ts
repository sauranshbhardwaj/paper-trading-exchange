import { CASH_DECIMALS, formatUnits, PRICE_DECIMALS, QTY_DECIMALS } from './money.ts';

function withDollarSign(formatted: string): string {
  return formatted.startsWith('-') ? `-$${formatted.slice(1)}` : `$${formatted}`;
}

/** Price units -> "$77,394.14" */
export function formatPrice(priceUnits: bigint): string {
  return withDollarSign(
    formatUnits(priceUnits, PRICE_DECIMALS, { minFraction: 2, grouping: true }),
  );
}

/** Cash units -> "$1,234.57" (rounded to cents for display only). */
export function formatCash(cashUnits: bigint): string {
  return withDollarSign(
    formatUnits(cashUnits, CASH_DECIMALS, { maxFraction: 2, minFraction: 2, grouping: true }),
  );
}

/** Quantity units -> "0.01500" (fixed decimals so columns line up). */
export function formatQty(qtyUnits: bigint, fractionDigits: number = QTY_DECIMALS): string {
  return formatUnits(qtyUnits, QTY_DECIMALS, {
    maxFraction: fractionDigits,
    minFraction: fractionDigits,
    grouping: true,
  });
}
