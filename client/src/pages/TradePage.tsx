import { useParams } from 'react-router';
import { isMarketSymbol } from '@pte/shared';
import { TradeView } from '../components/TradeView.tsx';
import { NotFoundPage } from './NotFoundPage.tsx';

export function TradePage() {
  const { market } = useParams();
  if (!market || !isMarketSymbol(market)) return <NotFoundPage />;
  // key resets all per-market state (form, clicked price) when switching markets.
  return <TradeView key={market} market={market} />;
}
