import { Link, NavLink } from 'react-router';
import { MARKET_SYMBOLS } from '@pte/shared';
import { useAccount } from '../context/AccountContext.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { useRealtime } from '../context/RealtimeContext.tsx';
import { displayCash } from '../lib/format.ts';
import { ConnectionBadge } from './ConnectionBadge.tsx';

export function NavBar() {
  const { user, logout } = useAuth();
  const { status } = useRealtime();
  const { balanceOf } = useAccount();
  const cash = balanceOf('USD');

  return (
    <nav className="tilt-nav">
      <Link to="/" className="tilt-brand" aria-label="Tilt Exchange home">
        <span className="tilt-logo" aria-hidden />
        Tilt
        <span className="tilt-brand-sub">exchange</span>
      </Link>

      <div className="tilt-markets">
        {MARKET_SYMBOLS.map((market) => (
          <NavLink key={market} to={`/trade/${market}`} className="tilt-market-link">
            {market}
          </NavLink>
        ))}
      </div>

      <div className="tilt-nav-right">
        <ConnectionBadge status={status} />
        {user ? (
          <>
            {cash && (
              <span className="tilt-cash" title="Cash available to trade">
                <span className="label">Cash</span>
                <span className="mono">{displayCash(cash.available)}</span>
              </span>
            )}
            <span className="tilt-user">{user.displayName}</span>
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary"
              onClick={() => void logout()}
            >
              Log out
            </button>
          </>
        ) : (
          <>
            <Link to="/login" className="btn btn-sm btn-outline-secondary">
              Log in
            </Link>
            <Link to="/register" className="btn btn-sm btn-accent">
              Sign up
            </Link>
          </>
        )}
      </div>
    </nav>
  );
}
