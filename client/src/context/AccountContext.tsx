/**
 * The logged-in user's balances and orders. Loaded over REST, then kept live
 * by private WebSocket messages, so fills show up without refreshing. After a
 * reconnect we reload over REST, because messages sent while we were offline
 * are gone for good.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { MARKETS, type Asset, type BalanceDto, type FillDto, type OrderDto } from '@pte/shared';
import { api } from '../lib/api.ts';
import { displayPrice, displayQty } from '../lib/format.ts';
import { applyOrderUpdate, EMPTY_ORDERS, mergeOrders, type OrdersState } from '../lib/orders.ts';
import { useAuth } from './AuthContext.tsx';
import { useRealtime } from './RealtimeContext.tsx';
import { useToasts, type ToastVariant } from './ToastContext.tsx';

interface AccountValue {
  balances: BalanceDto[];
  orders: OrdersState;
  loading: boolean;
  balanceOf: (asset: Asset) => BalanceDto | undefined;
  /** Merge an order returned by a REST call (ignored if we already have a newer version). */
  applyOrder: (order: OrderDto) => void;
}

const AccountContext = createContext<AccountValue | null>(null);

function makerFillToast(fill: FillDto): { variant: ToastVariant; title: string; body: string } {
  const verb = fill.side === 'buy' ? 'Bought' : 'Sold';
  return {
    variant: fill.side === 'buy' ? 'success' : 'info',
    title: `${verb} ${displayQty(fill.quantity, fill.market)} ${MARKETS[fill.market].base}`,
    body: `Someone traded with your order at ${displayPrice(fill.price)}.`,
  };
}

export function AccountProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { client, status } = useRealtime();
  const { push } = useToasts();
  const [balances, setBalances] = useState<BalanceDto[]>([]);
  const [orders, setOrders] = useState<OrdersState>(EMPTY_ORDERS);

  // Count successful (re)connections; each one triggers a fresh REST load.
  const [connections, setConnections] = useState(0);
  const [lastStatus, setLastStatus] = useState(status);
  if (status !== lastStatus) {
    setLastStatus(status);
    if (status === 'open') setConnections((count) => count + 1);
  }

  // Forget the previous user's data the moment the user changes.
  const [loadedFor, setLoadedFor] = useState(user?.id ?? null);
  if ((user?.id ?? null) !== loadedFor) {
    setLoadedFor(user?.id ?? null);
    setBalances([]);
    setOrders(EMPTY_ORDERS);
  }

  // Loading = "the latest load we asked for hasn't finished yet". Derived, not stored.
  const loadKey = user ? `${user.id}:${connections}` : null;
  const [finishedKey, setFinishedKey] = useState<string | null>(null);
  const loading = loadKey !== null && finishedKey !== loadKey;

  useEffect(() => {
    if (!user || loadKey === null) return;
    let cancelled = false;
    Promise.all([api.balances(), api.orders('open'), api.orders('closed')])
      .then(([balanceResponse, open, closed]) => {
        if (cancelled) return;
        setBalances(balanceResponse.balances);
        setOrders((current) => mergeOrders(current, [...open.orders, ...closed.orders]));
      })
      .catch(() => {
        if (!cancelled) push({ variant: 'danger', title: 'Could not load your account' });
      })
      .finally(() => {
        if (!cancelled) setFinishedKey(loadKey);
      });
    return () => {
      cancelled = true;
    };
  }, [user, loadKey, push]);

  useEffect(() => {
    if (!user) return;
    return client.onMessage((message) => {
      if (message.type === 'balances') setBalances(message.balances);
      if (message.type === 'order')
        setOrders((current) => applyOrderUpdate(current, message.order));
      // The order form already reports the trader's own (taker) fills; makers need to be told.
      if (message.type === 'fill' && message.fill.role === 'maker')
        push(makerFillToast(message.fill));
    });
  }, [client, user, push]);

  const balanceOf = useCallback(
    (asset: Asset) => balances.find((balance) => balance.asset === asset),
    [balances],
  );
  const applyOrder = useCallback((order: OrderDto) => {
    setOrders((current) => applyOrderUpdate(current, order));
  }, []);

  const value = useMemo(
    () => ({ balances, orders, loading, balanceOf, applyOrder }),
    [balances, orders, loading, balanceOf, applyOrder],
  );
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountValue {
  const value = useContext(AccountContext);
  if (!value) throw new Error('useAccount must be used inside <AccountProvider>');
  return value;
}
