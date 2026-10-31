import { useEffect, useReducer } from 'react';
import type { MarketSymbol } from '@pte/shared';
import { useRealtime } from '../context/RealtimeContext.tsx';
import { initialMarketState, marketReducer, type MarketState } from '../lib/marketState.ts';

type Action =
  | { kind: 'reset'; market: MarketSymbol }
  | { kind: 'message'; message: Parameters<typeof marketReducer>[1] };

function reducer(state: MarketState, action: Action): MarketState {
  return action.kind === 'reset'
    ? initialMarketState(action.market)
    : marketReducer(state, action.message);
}

/** Live order book, trades and reference price for one market. */
export function useMarketData(market: MarketSymbol): MarketState {
  const { client } = useRealtime();
  const [state, dispatch] = useReducer(reducer, market, initialMarketState);

  useEffect(() => {
    dispatch({ kind: 'reset', market });
    const stopListening = client.onMessage((message) => dispatch({ kind: 'message', message }));
    const unsubscribe = client.subscribe(market);
    return () => {
      unsubscribe();
      stopListening();
    };
  }, [client, market]);

  return state;
}
