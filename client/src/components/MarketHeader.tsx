import { formatPrice, MARKETS, type MarketSymbol } from '@pte/shared';
import { usePriceFlash } from '../hooks/usePriceFlash.ts';
import { basisPoints, percentDifference, priceUnits } from '../lib/format.ts';
import type { MarketState } from '../lib/marketState.ts';

interface MarketHeaderProps {
  market: MarketSymbol;
  data: MarketState;
}

/**
 * The signature strip: Coinbase's price next to the price *our users* last
 * traded at, and how far apart they are — the whole point of a P2P exchange.
 */
export function MarketHeader({ market, data }: MarketHeaderProps) {
  const config = MARKETS[market];
  const reference = data.ticker?.referencePrice ? priceUnits(data.ticker.referencePrice) : null;
  const lastTrade = data.trades[0] ? priceUnits(data.trades[0].price) : null;
  const bestBid = data.book?.bids[0] ? priceUnits(data.book.bids[0].price) : null;
  const bestAsk = data.book?.asks[0] ? priceUnits(data.book.asks[0].price) : null;
  const flash = usePriceFlash(reference);
  const stale = data.ticker?.stale ?? true;
  const divergence =
    lastTrade !== null && reference !== null ? basisPoints(lastTrade, reference) : 0n;
  const divergenceClass = divergence > 0n ? 'text-bid' : divergence < 0n ? 'text-ask' : '';

  return (
    <header className="market-header">
      <div className="market-title">
        <h1>
          {config.base}
          <span className="market-quote">/{config.quote}</span>
        </h1>
        <span className="market-name">{config.displayName}</span>
      </div>

      <div className="market-stat market-stat-hero">
        <span className="label">Coinbase reference</span>
        <span
          key={reference?.toString() ?? 'none'}
          className={`value mono price-hero ${flash ? `flash-${flash}` : ''}`}
        >
          {reference === null ? '—' : formatPrice(reference)}
        </span>
      </div>

      <div className="market-stat">
        <span className="label">Last P2P trade</span>
        <span className="value mono">{lastTrade === null ? '—' : formatPrice(lastTrade)}</span>
      </div>

      <div className="market-stat">
        <span className="label">P2P vs Coinbase</span>
        <span className={`value mono ${divergenceClass}`}>
          {lastTrade === null || reference === null ? '—' : percentDifference(lastTrade, reference)}
        </span>
      </div>

      <div className="market-stat">
        <span className="label">Bid / Ask</span>
        <span className="value mono">
          <span className="text-bid">{bestBid === null ? '—' : formatPrice(bestBid)}</span>
          <span className="text-muted-tilt"> / </span>
          <span className="text-ask">{bestAsk === null ? '—' : formatPrice(bestAsk)}</span>
        </span>
      </div>

      {data.ticker && stale && (
        <div className="market-warning" role="alert">
          Live price unavailable — trading is paused until the feed reconnects.
        </div>
      )}
    </header>
  );
}
