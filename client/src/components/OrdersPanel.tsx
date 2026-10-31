import { useState } from 'react';
import { MARKETS, type OrderDto } from '@pte/shared';
import { useAccount } from '../context/AccountContext.tsx';
import { useToasts } from '../context/ToastContext.tsx';
import { api, ApiError } from '../lib/api.ts';
import { displayPrice, displayQty, timeOfDay } from '../lib/format.ts';
import { statusLabel } from '../lib/orderMessages.ts';
import { Panel } from './Panel.tsx';

type Tab = 'open' | 'history';

export function OrdersPanel() {
  const { orders, applyOrder } = useAccount();
  const { push } = useToasts();
  const [tab, setTab] = useState<Tab>('open');
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set());
  const list = tab === 'open' ? orders.open : orders.history;

  async function cancel(order: OrderDto) {
    setCancelling((current) => new Set(current).add(order.id));
    try {
      const { order: updated } = await api.cancelOrder(order.id);
      applyOrder(updated);
      push({
        variant: 'info',
        title: 'Order cancelled',
        body: 'The funds it held are available again.',
      });
    } catch (error) {
      push({
        variant: 'danger',
        title: 'Could not cancel order',
        body: error instanceof ApiError ? error.message : 'Please try again.',
      });
    } finally {
      setCancelling((current) => {
        const next = new Set(current);
        next.delete(order.id);
        return next;
      });
    }
  }

  const tabs = (
    <div className="panel-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'open'}
        onClick={() => setTab('open')}
      >
        Open <span className="count">{orders.open.length}</span>
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'history'}
        onClick={() => setTab('history')}
      >
        History
      </button>
    </div>
  );

  return (
    <Panel title="Your orders" actions={tabs} className="orders-panel">
      {list.length === 0 ? (
        <p className="book-empty">{tab === 'open' ? 'No open orders.' : 'No past orders yet.'}</p>
      ) : (
        <div className="table-responsive">
          <table className="table table-sm tilt-table mb-0">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Market</th>
                <th scope="col">Side</th>
                <th scope="col">Type</th>
                <th scope="col" className="text-end">
                  Price
                </th>
                <th scope="col" className="text-end">
                  Amount
                </th>
                <th scope="col" className="text-end">
                  Filled
                </th>
                <th scope="col">Status</th>
                {tab === 'open' && <th scope="col" aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {list.map((order) => (
                <tr key={order.id}>
                  <td className="mono text-muted-tilt">{timeOfDay(order.createdAt)}</td>
                  <td>{order.market}</td>
                  <td className={order.side === 'buy' ? 'text-bid' : 'text-ask'}>
                    {order.side.toUpperCase()}
                  </td>
                  <td className="text-capitalize">{order.type}</td>
                  <td className="text-end mono">
                    {order.type === 'market' ? 'Market' : displayPrice(order.price)}
                  </td>
                  <td className="text-end mono">
                    {displayQty(order.quantity, order.market)} {MARKETS[order.market].base}
                  </td>
                  <td className="text-end mono">
                    {displayQty(order.filledQuantity, order.market)}
                  </td>
                  <td>
                    <span className={`status-pill status-${order.status}`}>
                      {statusLabel(order)}
                    </span>
                  </td>
                  {tab === 'open' && (
                    <td className="text-end">
                      <button
                        type="button"
                        className="btn btn-link btn-sm cancel-btn"
                        disabled={cancelling.has(order.id)}
                        onClick={() => void cancel(order)}
                      >
                        {cancelling.has(order.id) ? 'Cancelling…' : 'Cancel'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
