import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  ASSET_DECIMALS,
  formatCash,
  formatUnits,
  isDecimalString,
  MARKET_ORDER_PROTECTION_BPS,
  MARKETS,
  parseUnits,
  PRICE_DECIMALS,
  type MarketSymbol,
  type PlaceOrderInput,
} from '@pte/shared';
import { useAccount } from '../context/AccountContext.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { useToasts } from '../context/ToastContext.tsx';
import { api, ApiError } from '../lib/api.ts';
import { displayAsset } from '../lib/format.ts';
import {
  fractionOfMax,
  maxQuantity,
  previewOrder,
  type OrderFormValues,
} from '../lib/orderForm.ts';
import { orderResultToast } from '../lib/orderMessages.ts';
import { Panel } from './Panel.tsx';

const PERCENTAGES = [25, 50, 75, 100] as const;

interface OrderFormProps {
  market: MarketSymbol;
  /** Fresh reference price in price units, or null when the feed is down. */
  referencePrice: bigint | null;
  /** Set when the user clicks a price in the order book. `nonce` makes repeat clicks count. */
  priceSelection: { price: string; nonce: number } | null;
}

function toInput(value: FormDataEntryValue | string): string {
  return String(value).replace(',', '.');
}

export function OrderForm({ market, referencePrice, priceSelection }: OrderFormProps) {
  const config = MARKETS[market];
  const { user } = useAuth();
  const { balanceOf, applyOrder } = useAccount();
  const { push } = useToasts();
  const [form, setForm] = useState<OrderFormValues>({
    side: 'buy',
    type: 'limit',
    price: '',
    quantity: '',
  });
  const [attempted, setAttempted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Copy a clicked order-book price into the form ("adjust state while rendering" pattern).
  const [appliedNonce, setAppliedNonce] = useState<number | null>(null);
  if (priceSelection && priceSelection.nonce !== appliedNonce) {
    setAppliedNonce(priceSelection.nonce);
    setForm((current) => ({ ...current, type: 'limit', price: priceSelection.price }));
    setServerError(null);
  }

  if (!user) {
    return (
      <Panel title="Place order">
        <div className="order-cta">
          <p>
            Trade {config.base} against real people with <strong>$100,000</strong> in play money.
          </p>
          <div className="d-flex gap-2 justify-content-center">
            <Link to="/register" className="btn btn-accent">
              Create account
            </Link>
            <Link to="/login" className="btn btn-outline-secondary">
              Log in
            </Link>
          </div>
        </div>
      </Panel>
    );
  }

  const holdAsset = form.side === 'buy' ? config.quote : config.base;
  const balance = balanceOf(holdAsset);
  const available = balance
    ? parseUnits(balance.available, ASSET_DECIMALS[holdAsset], 'truncate')
    : 0n;
  const limitPrice = isDecimalString(form.price)
    ? parseUnits(form.price, PRICE_DECIMALS, 'truncate')
    : null;
  const max = maxQuantity(config, form, available, limitPrice, referencePrice);
  const preview = previewOrder(config, form, referencePrice);
  const filledIn = form.quantity !== '' && (form.type === 'market' || form.price !== '');
  const error = serverError ?? (attempted || filledIn ? preview.error : null);
  const isBuy = form.side === 'buy';

  function update(patch: Partial<OrderFormValues>) {
    setForm((current) => ({ ...current, ...patch }));
    setServerError(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setAttempted(true);
    if (preview.error) return;

    const input: PlaceOrderInput =
      form.type === 'limit'
        ? { type: 'limit', market, side: form.side, price: form.price, quantity: form.quantity }
        : { type: 'market', market, side: form.side, quantity: form.quantity };

    setSubmitting(true);
    try {
      const { order } = await api.placeOrder(input);
      applyOrder(order);
      push(orderResultToast(order));
      setForm((current) => ({ ...current, quantity: '' }));
      setAttempted(false);
    } catch (caught) {
      setServerError(
        caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Panel title="Place order" className="order-form">
      <form onSubmit={(event) => void submit(event)} noValidate>
        <div className="side-toggle" role="group" aria-label="Side">
          <button
            type="button"
            className={`side-btn side-buy ${isBuy ? 'active' : ''}`}
            aria-pressed={isBuy}
            onClick={() => update({ side: 'buy' })}
          >
            Buy
          </button>
          <button
            type="button"
            className={`side-btn side-sell ${!isBuy ? 'active' : ''}`}
            aria-pressed={!isBuy}
            onClick={() => update({ side: 'sell' })}
          >
            Sell
          </button>
        </div>

        <div className="type-toggle" role="group" aria-label="Order type">
          {(['limit', 'market'] as const).map((type) => (
            <button
              key={type}
              type="button"
              className={form.type === type ? 'active' : ''}
              aria-pressed={form.type === type}
              onClick={() => update({ type })}
            >
              {type === 'limit' ? 'Limit' : 'Market'}
            </button>
          ))}
        </div>

        {form.type === 'limit' ? (
          <div className="mb-3">
            <label htmlFor="order-price" className="form-label">
              Price
            </label>
            <div className="input-group">
              <input
                id="order-price"
                className="form-control mono"
                inputMode="decimal"
                autoComplete="off"
                placeholder={referencePrice ? formatUnits(referencePrice, PRICE_DECIMALS) : '0.00'}
                value={form.price}
                onChange={(event) => update({ price: toInput(event.target.value) })}
              />
              <button
                type="button"
                className="btn btn-outline-secondary"
                disabled={referencePrice === null}
                onClick={() =>
                  referencePrice !== null &&
                  update({ price: formatUnits(referencePrice, PRICE_DECIMALS, { minFraction: 2 }) })
                }
              >
                Live
              </button>
              <span className="input-group-text">USD</span>
            </div>
          </div>
        ) : (
          <p className="market-note">
            Fills immediately at the best prices on the book, never more than{' '}
            {MARKET_ORDER_PROTECTION_BPS / 100}% from the live price. Anything that can't fill is
            cancelled.
          </p>
        )}

        <div className="mb-2">
          <label htmlFor="order-quantity" className="form-label">
            Amount
          </label>
          <div className="input-group">
            <input
              id="order-quantity"
              className="form-control mono"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              value={form.quantity}
              onChange={(event) => update({ quantity: toInput(event.target.value) })}
            />
            <span className="input-group-text">{config.base}</span>
          </div>
        </div>

        <div className="percent-row" role="group" aria-label="Amount presets">
          {PERCENTAGES.map((percent) => (
            <button
              key={percent}
              type="button"
              disabled={max === 0n}
              onClick={() => update({ quantity: fractionOfMax(max, percent, config.qtyStep) })}
            >
              {percent === 100 ? 'Max' : `${percent}%`}
            </button>
          ))}
        </div>

        <dl className="order-summary">
          <div>
            <dt>Available</dt>
            <dd className="mono">
              {balance ? displayAsset(holdAsset, balance.available) : '—'}{' '}
              {holdAsset !== 'USD' && holdAsset}
            </dd>
          </div>
          <div>
            <dt>{form.type === 'market' ? 'Estimated total' : 'Total'}</dt>
            <dd className="mono">{preview.total === null ? '—' : formatCash(preview.total)}</dd>
          </div>
          {form.type === 'market' && isBuy && preview.reserve !== null && (
            <div>
              <dt>Reserved until filled</dt>
              <dd className="mono">{formatCash(preview.reserve)}</dd>
            </div>
          )}
        </dl>

        {error && (
          <div className="alert alert-danger py-2 small" role="alert">
            {error}
          </div>
        )}

        <button
          type="submit"
          className={`btn w-100 submit-btn ${isBuy ? 'btn-buy' : 'btn-sell'}`}
          disabled={submitting}
        >
          {submitting ? 'Placing…' : `${isBuy ? 'Buy' : 'Sell'} ${config.base}`}
        </button>
      </form>
    </Panel>
  );
}
