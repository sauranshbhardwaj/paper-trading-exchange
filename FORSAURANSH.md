# FOR SAURANSH: How Tilt Exchange Actually Works

> A tour of the codebase written for humans. Read it with a coffee, not a deadline.

---

## 1. The one-sentence version

**Tilt is a tiny stock exchange for crypto where the price is whatever two people agree on**, and Coinbase is only used as a "sanity check" to keep people from typing nonsense prices.

Most "paper trading" apps are like a vending machine: you press BUY, the machine checks an API price, and you get your coins. There's no one on the other side. Tilt is a **farmers' market**: if you want to buy BTC, someone has to actually be willing to sell it to you, at a price you both accept. That's what makes it interesting — and what makes it hard.

---

## 2. The big picture

```
 Browser (React + Bootstrap)                       Node server (Express + ws)                 Postgres
 ─────────────────────────────                     ─────────────────────────────              ─────────
  Login / Register  ──── HTTP /api/auth ────────▶  auth routes ── scrypt, sessions ────────▶  users, sessions
  Order form        ──── HTTP /api/orders ──────▶  OrderService ─┬─ OrderBook (in memory)
                                                                 └─ one DB transaction ────▶  orders, trades, balances
  Order book, trades, ◀── WebSocket /ws ─────────  RealtimeHub ◀── events ── OrderService
  your fills & balances                                        ◀── PriceBoard ◀── Coinbase WebSocket (live BTC/ETH)
```

Three workspace packages live in one repo (an npm "monorepo"):

| Folder    | What it is                                                                | Analogy                           |
| --------- | ------------------------------------------------------------------------- | --------------------------------- |
| `shared/` | Money math, market rules, validation schemas, the shapes of API messages  | The rulebook both teams play by   |
| `server/` | Express API, matching engine, database code, WebSocket hub, Coinbase feed | The exchange floor + the vault    |
| `client/` | React UI styled with Bootstrap                                            | The trading terminal on your desk |

The key idea: **`shared/` is imported by both the server and the browser.** When the order form tells you "Price must be within 10% of the live price", it's running _the exact same function_ the server will run. They can never disagree, because there's only one copy of the rule.

---

## 3. Follow one order through the system

Let's say Bob buys 0.02 BTC at $77,410.35, and Alice already has a sell order sitting at that price.

**① The form (client).** `OrderForm.tsx` keeps what Bob typed as _strings_ ("0.02"). On every keystroke, `previewOrder()` in `client/src/lib/orderForm.ts` validates it using the shared Zod schema and `resolveOrder()`, and shows the total. Bob clicks **Buy BTC**.

**② The API (server).** `POST /api/orders` lands in `server/src/trading/routes.ts`. Zod parses the body and turns `"0.02"` into `2_000_000n` (a BigInt — more on that in §4). Then it calls `orderService.placeOrder()`.

**③ Get in line.** `OrderService` puts the request into a **per-market queue** (`KeyedSerialQueue`). Only one BTC order is processed at a time; ETH orders run in parallel on their own queue. (Why? See §5.)

**④ Check the rules.** `resolveOrder()` (shared) checks: is the quantity a multiple of 0.00001 BTC? Is the price within ±10% of Coinbase? Is the order worth at least $1? It also works out what Bob must **lock up**: $77,410.35 × 0.02 = $1,548.21.

**⑤ Open a database transaction.** Everything from here until COMMIT is all-or-nothing.

- Insert the order row. Its auto-increment `id` doubles as "who got here first".
- Ask the in-memory `OrderBook`: _"what would this match?"_ — `book.match()` **only calculates**, it doesn't change anything. Answer: one fill against Alice, 0.02 BTC at $77,410.35.
- `computeSettlement()` (pure function) turns that into balance changes: Bob −$1,548.21, +0.02 BTC; Alice −0.02 BTC (from her locked coins), +$1,548.21.
- Lock every balance row involved with one sorted `SELECT … FOR UPDATE`, confirm Bob really has $1,548.21 available, write everything, **COMMIT**.

**⑥ Only now, update memory.** `book.apply()` removes Alice's filled quantity from the in-memory book.

**⑦ Tell everyone.** `OrderService` emits events (`trade`, `fill`, `orderUpdated`, `balancesChanged`, `bookChanged`). `RealtimeHub` listens and pushes:

- to _everyone watching BTC-USD_: the new trade and the updated order book;
- to _Bob only_: his order update and new balances;
- to _Alice only_: "Sold 0.02 BTC — someone traded with your order", which pops up as a toast without her refreshing.

That's the whole exchange. Everything else is details — but the details are where the marks (and the bugs) are.

---

## 4. Why money is stored as BigInt "units" (and never as a JS number)

Open a browser console and type `0.1 + 0.2`. You get `0.30000000000000004`. That's fine for a game's physics engine; it's a disaster for an exchange, where every dollar has to reconcile exactly.

So we do what banks do: **count in the smallest unit, as whole numbers.**

| Thing    | 1 unit equals                 | Example                             |
| -------- | ----------------------------- | ----------------------------------- |
| Quantity | 0.00000001 coin (a "satoshi") | 0.02 BTC → `2_000_000n`             |
| Price    | $0.01                         | $77,410.35 → `7_741_035n`           |
| Cash     | $0.0000000001                 | $100,000 → `1_000_000_000_000_000n` |

The clever-but-simple trick is that **cash has exactly price-decimals + quantity-decimals (2 + 8 = 10) decimals**. That means `price × quantity = cost` with **no rounding, ever**. No rounding means no "where did that 0.3 cents go?" bugs, and our tests can assert that the total amount of USD and BTC in the whole system never changes by even one unit.

The `n` suffix makes it a BigInt — arbitrary-precision integers built into JavaScript. Postgres stores them as `BIGINT`. Over JSON we send exact decimal strings like `"0.02"` (JSON can't carry BigInt, and sending floats would reintroduce the problem). All conversions go through `parseUnits()` / `formatUnits()` in `shared/src/money.ts`.

> **Lesson:** when correctness matters, pick a representation where the bug _can't happen_ rather than one where you have to remember to avoid it.

---

## 5. The hard parts the proposal promised — and how each is solved

### "Holding a user's money so they can't spend it twice"

Every balance row has two columns: `available` and `held`. Placing an order moves money from `available` → `held`. Think of a hotel pre-authorizing your card: the money is still yours, but you can't spend it elsewhere.

The one rule everything depends on (it's at the top of `server/src/engine/settlement.ts`):

> **An open order always holds exactly `holdAmountFor(side, limitPrice, remaining)`** — cash at its limit price for buys, the coins themselves for sells.

Fills consume the hold, cancels release it, and if a buyer gets a _better_ price than their limit, the difference goes straight back to `available`. An integration test (`expectHeldMatchesOpenOrders`) recomputes this from scratch after every scenario.

And as a last line of defence, the database itself has `CHECK (available >= 0)`. Even if our code had a bug, Postgres would refuse to save a negative balance and the whole trade would roll back.

### "Two orders arriving at the same time"

Node runs one line of JavaScript at a time, so people assume it's immune to race conditions. It isn't. Every `await` is a pause where another request can sneak in:

```
Order A: reads book → "Alice's ask is free" → await DB...
Order B:                                        reads book → "Alice's ask is free" → await DB...
Both fill the same ask. Alice sold coins she had once, twice.
```

The fix is `KeyedSerialQueue`: one line per market, like one cashier per register. BTC orders wait for each other; ETH orders use a different register. The concurrency tests fire 10 orders at once from a user who can only afford 5 — exactly 5 succeed, every time.

### "Not deadlocking the database"

BTC and ETH queues run in parallel and both touch your **USD** row. Imagine two people in a narrow hallway, each waiting for the other to step aside — that's a deadlock. Our fix: every transaction locks _all_ the balance rows it needs in one statement, **sorted by (user_id, asset)**. If everyone grabs locks in the same order, nobody can end up waiting on each other in a circle.

### "Match → persist → apply" (the pattern worth remembering)

The order book lives in memory (fast) but the database is the truth (durable). If we changed the in-memory book first and then the database write failed, they'd disagree forever. So:

1. `match()` — calculate only (pure, can't fail halfway),
2. persist — one transaction,
3. `apply()` — change memory only after COMMIT.

It's "write the receipt before handing over the goods". This is also why **restart recovery** is trivial: on boot, `loadOpenOrders()` rebuilds the book from `orders WHERE status = 'open' ORDER BY id`, and time priority is preserved because the id _is_ the arrival order.

### "Stopping users from trading against themselves"

In `OrderBook.match()`, if the next resting order belongs to the same user, matching stops and the rest of the incoming order is cancelled with reason `self_trade_prevention` ("cancel newest" — the same default many real exchanges use). The database has `CHECK (buyer_id <> seller_id)` on trades as a backstop.

### "Rejecting orders priced way off the market"

`priceBand()` allows ±10% of the Coinbase price. Market orders are secretly limit orders at ±5% that cancel whatever doesn't fill immediately ("slippage protection"), so a market buy on an empty book can't accidentally pay $1,000,000. If Coinbase goes quiet for 60 seconds, trading pauses — a real exchange "halt".

---

## 6. Tour of the codebase

```
shared/src/
  money.ts        BigInt units, parse/format, exact maths          ← start here
  markets.ts      BTC-USD / ETH-USD config, band sizes, $100k start
  orderRules.ts   resolveOrder(): validation + how much to hold     ← used by form AND server
  schemas.ts      Zod schemas for every request and WS message
  types.ts        DTOs: what the API/WS sends back

server/src/
  engine/orderBook.ts     the matching engine (pure, no DB)        ← the heart
  engine/settlement.ts    fills → balance deltas (pure)
  trading/orderService.ts orchestrates queue + transaction + events ← the brain
  trading/*Repo.ts        all SQL lives here, nowhere else
  trading/serialQueue.ts  one-at-a-time per market
  market-data/            PriceBoard (latest prices) + Coinbase/mock feeds
  realtime/hub.ts         WebSocket fan-out, coalesced book updates
  auth/                   scrypt passwords, cookie sessions
  app.ts / index.ts       wiring; index.ts is the only file that "starts" things
  migrations/001_init.sql the schema, with CHECK constraints as guard rails

client/src/
  lib/            pure logic (format, order form maths, reducers) — all tested
  context/        Auth, Account (balances+orders), Realtime (one WS), Toasts
  components/     one component per file; TradeView assembles the page
  pages/          Login, Register, Trade, 404
```

Notice the layering: **pure logic at the bottom** (money, rules, matching, settlement — no I/O, trivially testable), **orchestration in the middle** (OrderService), **I/O at the edges** (routes, repos, WebSockets). When something breaks, you know which layer to look in.

---

## 7. Technology choices and why

| Choice                                                           | Why                                                                                                                                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Node runs TypeScript directly** (no build step for the server) | Node ≥ 22.18 strips types natively. Fewer moving parts on Render; `npm start` runs the source. Cost: no enums or constructor shorthand (`erasableSyntaxOnly`) and imports need `.ts` extensions. |
| **Raw SQL with `pg`, no ORM**                                    | Locking rows (`FOR UPDATE`), batch updates with `unnest`, and CHECK constraints are the _point_ of this project. An ORM would hide exactly the parts we want to show the professor.              |
| **Express 5**                                                    | Async route handlers' errors reach the error handler automatically (Express 4 needed wrappers).                                                                                                  |
| **`ws` for WebSockets**                                          | Small, battle-tested, shares the HTTP server and the session cookie.                                                                                                                             |
| **Cookie sessions, not JWT**                                     | We can revoke a session instantly on logout (and the hub kicks that socket). httpOnly means page JavaScript can't steal the token; we store only its SHA-256 hash.                               |
| **scrypt** (built into Node)                                     | No native module to break on deploy; deliberately slow so leaked hashes are expensive to crack.                                                                                                  |
| **React + Vite + Bootstrap**                                     | Proposal requires Bootstrap; React makes a live-updating trading screen manageable. Bootstrap is re-themed through CSS variables, so it looks like a terminal, not a Bootstrap demo.             |
| **Zod in `shared/`**                                             | One schema → server validation + form validation + TypeScript types. DRY across the network boundary.                                                                                            |
| **Vitest**                                                       | Same config style as Vite, fast, works for all three packages.                                                                                                                                   |

---

## 8. Bugs and gotchas we hit while building this (the good stuff)

1. **Nobody could sell anything.** The first smoke test worked perfectly… and was useless: every new user starts with only USD, so there were no coins anywhere to buy. A peer-to-peer market needs _someone_ to bring inventory. Fix for now: the dev seed gives alice/bob 1 BTC and 10 ETH. Real fix (roadmap step 2): the market-making bot starts with inventory. **Lesson:** run the product as a user as early as possible; unit tests would never have caught this.

2. **React StrictMode opens two WebSockets.** In development React deliberately runs effects twice to flush out bugs. Our `connect()` would have created two sockets and every message would arrive twice (double toasts, double trades). Fix: `connect()` is idempotent — if a socket is already open or connecting, it does nothing.

3. **A live trade can arrive _before_ the snapshot it belongs to.** When you subscribe, the server sends a "last 50 trades" snapshot from the DB; a brand-new trade can be broadcast while that query runs. Replacing the list with the snapshot would drop the new trade. Fix: `mergeTrades()` unions by id instead of replacing.

4. **A slow REST response can overwrite a newer WebSocket update.** Fix: `applyOrderUpdate()` ignores any order version older (`updatedAt`) than what we already have.

5. **Messages sent while you were offline are gone forever.** WebSockets don't replay. Fix: every time the socket reconnects, `AccountContext` reloads balances and orders over REST.

6. **"0.00%" shown in red.** The P2P-vs-Coinbase readout coloured itself by raw comparison, so a 1-cent difference showed a red 0.00%. Fix: colour by the same truncated basis-point value that's displayed.

7. **Console full of 401s for logged-out visitors.** `/api/auth/me` returned 401 for "not logged in", which browsers log as errors. It's a _question_ ("who am I?"), not a protected resource — now it returns `{ user: null }`.

8. **React 19's lint rules caught `setState` inside an effect.** We derived `loading` from state instead of setting it. The new rules feel strict but they push you toward fewer re-renders and fewer "flash of wrong state" bugs.

9. **The E2E test couldn't find the "Amount" field** because a button group was labelled "Amount presets" — accessibility labels are how testing tools (and screen readers) find things, so ambiguity there is a real UX issue too.

---

## 9. Pitfalls to avoid as you build the next steps

- **Never `Number()` an amount** except for display percentages. Use `parseUnits`/`formatUnits`.
- **Never touch `balances` outside a settlement/cancellation path in `OrderService`.** If the bot or deposits need to credit money, add a method there that uses `BalanceDeltas` + `applyBalanceDeltas`.
- **Deposits must be idempotent.** The blockchain watcher _will_ see the same transaction twice (retries, reorgs). Store the tx hash with a UNIQUE constraint and credit inside the same transaction.
- **Play money must never become real money.** If a single "ETH" balance could hold both play/Sepolia ETH and real ETH, someone could buy "ETH" with the free $100k (or deposit free Sepolia ETH) and withdraw it as _real_ ETH — draining the wallet that holds your actual money. That's why real-money mode uses **separate asset codes and a separate market** (`ETH.base`/`USDC.base`), and why test-ETH withdrawals are capped to what was deposited. Think of it like a casino: chips from the free-play table don't work at the cashier.
- **Real-money mode is fenced in, not just "turned on".** Allowlisted wallets only (anyone can find a public website), small caps, chain-ID checks so nobody sends mainnet money to a testnet flow, admin-approved withdrawals, and a kill switch. The rules live in `CLAUDE.md` so every AI session follows them too.
- **Render free tier sleeps after ~15 minutes idle** — the bot and Coinbase feed stop with it. Wake it up before demos.
- **Don't trust the client's price math.** The form preview is a convenience; the server re-validates everything.

---

## 10. How good engineers think (patterns you just used)

- **Make illegal states unrepresentable, then make them unstorable.** BigInt units make rounding bugs impossible; CHECK constraints make negative balances unsaveable.
- **Pure core, imperative shell.** The matching engine and settlement have no I/O, so they're tested with thousands of random orders in milliseconds. The messy parts (DB, sockets) are thin.
- **Test invariants, not just examples.** "After 300 random concurrent orders, total USD is unchanged, every hold matches its open orders, and the in-memory book equals the database." One such test beats fifty "buy 1 at 100" examples.
- **One source of truth.** The DB is the truth; memory is a cache rebuilt from it. Validation rules exist once, in `shared/`.
- **Fail closed.** No fresh price? Pause trading. Unknown error? Generic message, log the details, never leak a stack trace.

---

## 11. Running it

```bash
cp .env.example .env
npm install
npm run db:up && npm run db:seed
npm run dev                         # http://localhost:5173
# Two windows (one incognito): log in as alice and bob, trade with each other.
npm run test:all                    # ~180 tests
```

Further reading: Larry Harris, _Trading and Exchanges_ (ch. 6–7 on order books and priority rules); Martin Kleppmann, _Designing Data-Intensive Applications_ (ch. 7, transactions and race conditions); Avellaneda & Stoikov (2008) for the smarter bot in step 9.
