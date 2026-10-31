import type { CSSProperties } from 'react';
import { formatPrice, type BookDto, type BookLevelDto, type MarketSymbol } from '@pte/shared';
import { displayQty, percentDifference, priceUnits, qtyUnits } from '../lib/format.ts';
import { Panel } from './Panel.tsx';

const DEPTH = 12;

interface OrderBookPanelProps {
  market: MarketSymbol;
  book: BookDto | null;
  onSelectPrice: (price: string) => void;
}

interface Row {
  level: BookLevelDto;
  cumulative: bigint;
}

function withCumulative(levels: BookLevelDto[]): Row[] {
  let running = 0n;
  return levels.slice(0, DEPTH).map((level) => {
    running += qtyUnits(level.quantity);
    return { level, cumulative: running };
  });
}

export function OrderBookPanel({ market, book, onSelectPrice }: OrderBookPanelProps) {
  const bids = withCumulative(book?.bids ?? []);
  const asks = withCumulative(book?.asks ?? []);
  const maxDepth = [...bids, ...asks].reduce(
    (max, row) => (row.cumulative > max ? row.cumulative : max),
    0n,
  );
  const bestBid = book?.bids[0];
  const bestAsk = book?.asks[0];

  function renderRow({ level, cumulative }: Row, side: 'bid' | 'ask') {
    const depth = maxDepth > 0n ? Number((cumulative * 100n) / maxDepth) : 0;
    return (
      <button
        type="button"
        // Keyed by price AND quantity: when a level changes React remounts the row,
        // which replays the CSS flash animation. No timers or refs needed.
        key={`${level.price}:${level.quantity}`}
        className={`book-row book-row-${side}`}
        style={{ '--depth': `${depth}%` } as CSSProperties}
        onClick={() => onSelectPrice(level.price)}
        title="Use this price"
      >
        <span className="mono price">{formatPrice(priceUnits(level.price))}</span>
        <span className="mono">{displayQty(level.quantity, market)}</span>
        <span className="mono text-muted-tilt">{level.orderCount}</span>
      </button>
    );
  }

  return (
    <Panel title="Order book" className="order-book">
      <div className="book-columns">
        <span>Price</span>
        <span>Size</span>
        <span>Orders</span>
      </div>
      <div className="book-side book-asks">
        {asks.length === 0 ? (
          <p className="book-empty">No sellers yet</p>
        ) : (
          [...asks].reverse().map((row) => renderRow(row, 'ask'))
        )}
      </div>
      <div className="book-spread">
        {bestBid && bestAsk ? (
          <>
            <span>Spread</span>
            <span className="mono">
              {formatPrice(priceUnits(bestAsk.price) - priceUnits(bestBid.price))}
            </span>
            <span className="mono text-muted-tilt">
              {percentDifference(priceUnits(bestAsk.price), priceUnits(bestBid.price))}
            </span>
          </>
        ) : (
          <span className="text-muted-tilt">Click a price to fill it into the order form</span>
        )}
      </div>
      <div className="book-side book-bids">
        {bids.length === 0 ? (
          <p className="book-empty">No buyers yet</p>
        ) : (
          bids.map((row) => renderRow(row, 'bid'))
        )}
      </div>
    </Panel>
  );
}
