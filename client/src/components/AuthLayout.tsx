import type { ReactNode } from 'react';

interface AuthLayoutProps {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}

export function AuthLayout({ title, subtitle, children, footer }: AuthLayoutProps) {
  return (
    <main className="auth-page">
      <section className="auth-pitch" aria-hidden>
        <p className="auth-kicker">Peer-to-peer paper trading</p>
        <p className="auth-headline">
          Prices set by <em>people</em>,<br />
          not an API.
        </p>
        <ul className="auth-points">
          <li>$100,000 in play money on sign-up</li>
          <li>A real matching engine: price-time priority, partial fills</li>
          <li>Live BTC &amp; ETH reference prices from Coinbase</li>
        </ul>
      </section>
      <section className="auth-card">
        <h1>{title}</h1>
        <p className="text-muted-tilt">{subtitle}</p>
        {children}
        <div className="auth-footer">{footer}</div>
      </section>
    </main>
  );
}
