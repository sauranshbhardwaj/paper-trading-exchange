import { CASH_DECIMALS, parseUnits, QTY_DECIMALS } from './money.ts';

export const ASSETS = ['USD', 'BTC', 'ETH'] as const;
export type Asset = (typeof ASSETS)[number];
export type CoinAsset = Exclude<Asset, 'USD'>;

export const ASSET_DECIMALS: Record<Asset, number> = {
  USD: CASH_DECIMALS,
  BTC: QTY_DECIMALS,
  ETH: QTY_DECIMALS,
};

// Symbols match Coinbase product ids so the price feed can use them directly.
export const MARKET_SYMBOLS = ['BTC-USD', 'ETH-USD'] as const;
export type MarketSymbol = (typeof MARKET_SYMBOLS)[number];

export interface MarketConfig {
  symbol: MarketSymbol;
  base: CoinAsset;
  quote: 'USD';
  displayName: string;
  /** Quantities must be a whole multiple of this (in quantity units). Also the minimum size. */
  qtyStep: bigint;
  /** Smallest order value in cash units. Stops $0.0001 dust orders from cluttering the book. */
  minNotional: bigint;
  /** How many decimals the UI shows for quantities in this market. */
  qtyDisplayDecimals: number;
}

export const MARKETS: Record<MarketSymbol, MarketConfig> = {
  'BTC-USD': {
    symbol: 'BTC-USD',
    base: 'BTC',
    quote: 'USD',
    displayName: 'Bitcoin',
    qtyStep: parseUnits('0.00001', QTY_DECIMALS),
    minNotional: parseUnits('1', CASH_DECIMALS),
    qtyDisplayDecimals: 5,
  },
  'ETH-USD': {
    symbol: 'ETH-USD',
    base: 'ETH',
    quote: 'USD',
    displayName: 'Ethereum',
    qtyStep: parseUnits('0.0001', QTY_DECIMALS),
    minNotional: parseUnits('1', CASH_DECIMALS),
    qtyDisplayDecimals: 4,
  },
};

export function isMarketSymbol(value: string): value is MarketSymbol {
  return (MARKET_SYMBOLS as readonly string[]).includes(value);
}

/** Limit orders priced more than 10% away from the live reference price are rejected. */
export const PRICE_BAND_BPS = 1_000;
/** Market orders never fill more than 5% away from the reference price (slippage protection). */
export const MARKET_ORDER_PROTECTION_BPS = 500;
/** A reference price older than this is treated as unavailable, which pauses trading. */
export const REFERENCE_PRICE_MAX_AGE_MS = 60_000;

export const STARTING_CASH = parseUnits('100000', CASH_DECIMALS);
