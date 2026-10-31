-- Amounts are BIGINT integer "units" (see shared/src/money.ts):
--   price: cents, quantity: 1e-8 coin, cash balances: 1e-10 USD.
-- Constraints here are the last line of defence: even if application code has
-- a bug, the database refuses negative balances or impossible order states.

CREATE TABLE users (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         text NOT NULL UNIQUE, -- stored lowercased by the API
  password_hash text NOT NULL,
  display_name  text NOT NULL,
  is_bot        boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_display_name_key ON users (lower(display_name));

CREATE TABLE sessions (
  token_hash text PRIMARY KEY, -- sha256 of the cookie token; the raw token is never stored
  user_id    bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

CREATE TABLE balances (
  user_id   bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  asset     text NOT NULL CHECK (asset IN ('USD', 'BTC', 'ETH')),
  available bigint NOT NULL CHECK (available >= 0),
  held      bigint NOT NULL CHECK (held >= 0), -- locked behind open orders
  PRIMARY KEY (user_id, asset)
);

CREATE TABLE orders (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- also the time priority
  user_id         bigint NOT NULL REFERENCES users (id),
  market          text NOT NULL CHECK (market IN ('BTC-USD', 'ETH-USD')),
  side            text NOT NULL CHECK (side IN ('buy', 'sell')),
  type            text NOT NULL CHECK (type IN ('limit', 'market')),
  price           bigint NOT NULL CHECK (price > 0), -- market orders store their protection price
  quantity        bigint NOT NULL CHECK (quantity > 0),
  filled_quantity bigint NOT NULL DEFAULT 0 CHECK (filled_quantity >= 0 AND filled_quantity <= quantity),
  status          text NOT NULL CHECK (status IN ('open', 'filled', 'cancelled')),
  cancel_reason   text CHECK (cancel_reason IN ('user', 'unfilled_remainder', 'self_trade_prevention')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'filled') = (filled_quantity = quantity)),
  CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL))
);
-- Used on startup to rebuild the in-memory order books.
CREATE INDEX orders_open_by_market_idx ON orders (market, id) WHERE status = 'open';
CREATE INDEX orders_user_idx ON orders (user_id, id DESC);

CREATE TABLE trades (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market         text NOT NULL CHECK (market IN ('BTC-USD', 'ETH-USD')),
  price          bigint NOT NULL CHECK (price > 0),
  quantity       bigint NOT NULL CHECK (quantity > 0),
  maker_order_id bigint NOT NULL REFERENCES orders (id),
  taker_order_id bigint NOT NULL REFERENCES orders (id),
  buyer_id       bigint NOT NULL REFERENCES users (id),
  seller_id      bigint NOT NULL REFERENCES users (id),
  taker_side     text NOT NULL CHECK (taker_side IN ('buy', 'sell')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (buyer_id <> seller_id) -- self-trade prevention, enforced by the database as well
);
CREATE INDEX trades_market_idx ON trades (market, id DESC);
CREATE INDEX trades_buyer_idx ON trades (buyer_id, id DESC);
CREATE INDEX trades_seller_idx ON trades (seller_id, id DESC);
