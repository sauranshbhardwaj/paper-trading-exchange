# Tilt Exchange — project instructions

Peer-to-peer paper trading exchange (CS375, team "Vibe Coders on Tilt": Nitish Chawla, Sauransh Bhardwaj).
Users trade BTC/ETH with each other; prices come from the order book, Coinbase is only a reference.

## Stack (fixed by the course proposal — don't swap pieces out)

- **Server:** Node ≥ 22.18 running TypeScript directly (type stripping, no build), Express 5, `ws`, `pg` (raw SQL, no ORM), Zod.
- **Client:** React 19 + Vite + React Router 7 + **Bootstrap 5.3** (themed via CSS variables in `client/src/styles.css`).
- **Shared:** `@pte/shared` workspace package — money math, market config, order rules, Zod schemas, DTO types. Used by both sides.
- **DB:** Postgres 17 (Docker locally on port **5433**, Render in production).
- **Tests:** Vitest. Unit tests next to source (`*.test.ts`); DB integration tests in `server/test/*.int.test.ts`.

## Commands

```bash
npm run db:up            # start Postgres in Docker (creates pte + pte_test databases)
npm run db:seed          # demo users alice@example.com / bob@example.com, password: password123
npm run dev              # server :3000 + client :5173 (open http://localhost:5173)
npm test                 # unit tests (shared, server, client)
npm run test:integration # server tests against the pte_test database (needs db:up)
npm run test:all         # both
npm run typecheck && npm run lint
npm run build && NODE_ENV=production npm start   # production mode locally (serves client/dist)
```

Set `PRICE_FEED=mock` in `.env` to develop without internet (random-walk prices).

## Rules that keep the exchange correct — read before touching trading code

1. **Money is BigInt integer units, never JS numbers.** quantity = 1e-8 coin, price = cents, cash = 1e-10 USD
   (so price × quantity = cash exactly). Convert only at the edges with `parseUnits` / `formatUnits`. The API sends
   amounts as exact decimal strings. Postgres columns are BIGINT.
2. **All order placement/cancellation goes through `OrderService`**, which serializes per market (`KeyedSerialQueue`).
   Never mutate an `OrderBook` or the `balances` table from anywhere else.
3. **Match → persist → apply.** `OrderBook.match()` is pure; the DB transaction commits; only then `book.apply()` and
   events. Keep it that way or a failed transaction will desync memory from the DB.
4. **Hold invariant:** an open order holds exactly `holdAmountFor(side, limitPrice, remaining)`. Any new order type or
   fee must preserve it (the integration helper `expectHeldMatchesOpenOrders` checks it).
5. **Lock balance rows in one sorted `SELECT … FOR UPDATE`** (`lockBalances`) before writing — prevents deadlocks.
6. **Validation lives in `shared/`** (`schemas.ts`, `orderRules.ts`) so the form and server agree. Add rules there.
7. Errors shown to users come from `AppError` / `OrderRuleError` messages; anything else becomes a generic 500.
8. Schema changes = a new numbered file in `server/migrations/` (never edit an applied one). Runs on boot.
9. If you add client-side calls to external hosts (e.g. Alchemy, MetaMask RPC), update Helmet's CSP in `server/src/app.ts`.

## Conventions

- Imports use explicit `.ts`/`.tsx` extensions (required by Node type stripping).
- No enums, namespaces or constructor parameter properties (`erasableSyntaxOnly`).
- One component per file; pure logic in `client/src/lib/` with tests.
- Commits: `type(scope): description` (feat, fix, refactor, test, docs, chore).

## Real-money mode (demo only) — non-negotiable rules

The professor asked for optional real-money support. Only the team and the professor use it, but the site is public,
so the code must make misuse impossible:

1. **Separate ledgers.** Real assets get their own asset codes (e.g. `ETH.base`, `USDC.base`) and their own market.
   They never trade against play `USD`, play coins or Sepolia ETH, and withdrawals of a real asset come only from that
   asset's real balance. Play money must never be convertible into real money.
2. **Off by default** behind a `REAL_MONEY_ENABLED` env flag; **wallet allowlist** (team + professor); **per-user and
   total caps**; **chain-ID check** before every wallet transaction (Base 8453 for real, Sepolia 11155111 for test).
3. **Withdrawals:** signed by the linked wallet, sent only to that wallet, admin-approved, idempotent (one request id →
   at most one on-chain transfer), and auto-paused if the exchange wallet's on-chain balance is below total user balances.
4. **Deposits:** credited only from allowlisted, linked wallets, after confirmations, once per tx hash (UNIQUE constraint).
5. **Keys:** the exchange wallet key lives only in Render env vars — never in code, logs, or `.env.example`.
6. Develop and test on Sepolia / Base Sepolia / a local chain. Real-money transactions are run by the team by hand.

## Roadmap (10 steps, 5 each) — keep this updated

| #   | Owner    | Step                                                                                                 | Status  |
| --- | -------- | ---------------------------------------------------------------------------------------------------- | ------- |
| 1   | Sauransh | Foundation: monorepo, auth, matching engine, settlement, live book/trades over WS, trading UI        | ✅ done |
| 2   | Nitish   | Deploy to Render + market-making bot v1 (seeded inventory, quotes around Coinbase)                   | ☐       |
| 3   | Sauransh | Portfolio page: holdings, avg cost, P&L, trade history, portfolio value chart, account reset         | ☐       |
| 4   | Nitish   | MetaMask + Sign-In with Ethereum (new accounts and linking to existing ones)                         | ☐       |
| 5   | Sauransh | Deposits for any network (Sepolia + Base): Alchemy, confirmations, idempotent, allowlist, caps       | ☐       |
| 6   | Nitish   | Leaderboard + candlestick charts (our trades + Coinbase overlay) + depth chart                       | ☐       |
| 7   | Sauransh | Advanced orders: IOC, FOK, stop-limit; maker/taker fees                                              | ☐       |
| 8   | Nitish   | Testing depth: Stryker, Playwright E2E, GitHub Actions CI; exchange audit page                       | ☐       |
| 9   | Sauransh | Withdrawals (capped test ETH; admin-approved real) + real-money ETH-USDC market and its guardrails   | ☐       |
| 10  | Nitish   | Circuit breaker, security/rate-limit pass, demo polish; stretch: leagues, bot personalities, A–S bot | ☐       |
