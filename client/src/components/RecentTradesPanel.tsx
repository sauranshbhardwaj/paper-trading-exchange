import type { MarketSymbol, TradeDto } from '@pte/shared';
import { displayPrice, displayQty, timeOfDay } from '../lib/format.ts';
import { Panel } from './Panel.tsx';

interface RecentTradesPanelProps {
  market: MarketSymbol;
  trades: TradeDto[];
}

export function RecentTradesPanel({ market, trades }: RecentTradesPanelProps) {
  return (
    <Panel title="Recent trades" className="recent-trades">
      <div className="trades-columns">
        <span>Price</span>
        <span>Size</span>
        <span>Time</span>
      </div>
      {trades.length === 0 ? (
        <p className="book-empty">No trades yet — be the first.</p>
      ) : (
        <ol className="trades-list">
          {trades.map((trade) => (
            <li key={trade.id} className="trade-row">
              <span className={`mono ${trade.takerSide === 'buy' ? 'text-bid' : 'text-ask'}`}>
                {displayPrice(trade.price)}
              </span>
              <span className="mono">{displayQty(trade.quantity, market)}</span>
              <span className="mono text-muted-tilt">{timeOfDay(trade.createdAt)}</span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
