/**
 * The API sends exact decimal strings ("0.015"). These turn them into display
 * text using the shared formatters, so the UI rounds exactly like the server.
 */
import {
  ASSET_DECIMALS,
  CASH_DECIMALS,
  formatCash,
  formatPrice,
  formatQty,
  isDecimalString,
  MARKETS,
  parseUnits,
  PRICE_DECIMALS,
  QTY_DECIMALS,
  type Asset,
  type MarketSymbol,
} from '@pte/shared';

function safeUnits(value: string, decimals: number): bigint | null {
  return isDecimalString(value) ? parseUnits(value, decimals, 'truncate') : null;
}

export function priceUnits(value: string): bigint {
  return safeUnits(value, PRICE_DECIMALS) ?? 0n;
}

export function qtyUnits(value: string): bigint {
  return safeUnits(value, QTY_DECIMALS) ?? 0n;
}

export function displayPrice(value: string | null | undefined): string {
  if (!value) return '—';
  return formatPrice(priceUnits(value));
}

export function displayQty(value: string, market: MarketSymbol): string {
  return formatQty(qtyUnits(value), MARKETS[market].qtyDisplayDecimals);
}

export function displayCash(value: string): string {
  return formatCash(safeUnits(value, CASH_DECIMALS) ?? 0n);
}

export function displayAsset(asset: Asset, value: string): string {
  if (asset === 'USD') return displayCash(value);
  return formatQty(safeUnits(value, ASSET_DECIMALS[asset]) ?? 0n, asset === 'BTC' ? 5 : 4);
}

export function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour12: false });
}

/** Difference of `value` vs `reference` in basis points (1 bp = 0.01%), truncated toward zero. */
export function basisPoints(value: bigint, reference: bigint): bigint {
  return reference === 0n ? 0n : ((value - reference) * 10_000n) / reference;
}

/** Signed percentage difference of `value` vs `reference`, e.g. "+0.12%". */
export function percentDifference(value: bigint, reference: bigint): string {
  if (reference === 0n) return '—';
  // Basis points with BigInt, then format: avoids float drift on large prices.
  const bps = basisPoints(value, reference);
  const sign = bps > 0n ? '+' : bps < 0n ? '−' : '';
  const magnitude = bps < 0n ? -bps : bps;
  return `${sign}${(Number(magnitude) / 100).toFixed(2)}%`;
}
