import { useState } from 'react';
import type { MarketSymbol } from '@pte/shared';
import { useAuth } from '../context/AuthContext.tsx';
import { useMarketData } from '../hooks/useMarketData.ts';
import { priceUnits } from '../lib/format.ts';
import { BalancesPanel } from './BalancesPanel.tsx';
import { MarketHeader } from './MarketHeader.tsx';
import { OrderBookPanel } from './OrderBookPanel.tsx';
import { OrderForm } from './OrderForm.tsx';
import { OrdersPanel } from './OrdersPanel.tsx';
import { RecentTradesPanel } from './RecentTradesPanel.tsx';

export function TradeView({ market }: { market: MarketSymbol }) {
  const { user } = useAuth();
  const data = useMarketData(market);
  const [priceSelection, setPriceSelection] = useState<{ price: string; nonce: number } | null>(
    null,
  );

  const ticker = data.ticker;
  const referencePrice =
    ticker && !ticker.stale && ticker.referencePrice ? priceUnits(ticker.referencePrice) : null;

  return (
    <main className="trade-page">
      <MarketHeader market={market} data={data} />
      <div className="trade-grid">
        <OrderBookPanel
          market={market}
          book={data.book}
          onSelectPrice={(price) =>
            setPriceSelection((previous) => ({ price, nonce: (previous?.nonce ?? 0) + 1 }))
          }
        />
        <div className="trade-center">
          <OrderForm
            market={market}
            referencePrice={referencePrice}
            priceSelection={priceSelection}
          />
          {user && <BalancesPanel />}
        </div>
        <RecentTradesPanel market={market} trades={data.trades} />
        {user && <OrdersPanel />}
      </div>
    </main>
  );
}
