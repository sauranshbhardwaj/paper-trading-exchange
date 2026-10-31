import { describe, expect, it } from 'vitest';
import { OrderBook, type IncomingOrder, type MatchResult } from './orderBook.ts';

let nextId = 1;
function order(
  overrides: Partial<IncomingOrder> & Pick<IncomingOrder, 'side' | 'price' | 'remaining'>,
): IncomingOrder {
  return { id: String(nextId++), userId: 'u1', timeInForce: 'GTC', ...overrides };
}

/** match + apply in one go, the way the order service uses it. */
function submit(book: OrderBook, incoming: IncomingOrder): MatchResult {
  const result = book.match(incoming);
  book.apply(incoming, result);
  return result;
}

describe('OrderBook', () => {
  describe('resting orders', () => {
    it('rests a limit order when the book is empty', () => {
      const book = new OrderBook('BTC-USD');
      const result = submit(book, order({ side: 'buy', price: 100n, remaining: 5n }));
      expect(result).toEqual({ fills: [], remaining: 5n, outcome: 'resting' });
      expect(book.bestBid()).toBe(100n);
      expect(book.bestAsk()).toBeNull();
    });

    it('expires an IOC order when nothing can fill', () => {
      const book = new OrderBook('BTC-USD');
      const result = submit(
        book,
        order({ side: 'buy', price: 100n, remaining: 5n, timeInForce: 'IOC' }),
      );
      expect(result.outcome).toBe('expired');
      expect(book.size).toBe(0);
    });

    it('does not trade when prices do not cross', () => {
      const book = new OrderBook('BTC-USD');
      submit(book, order({ userId: 'seller', side: 'sell', price: 101n, remaining: 5n }));
      const result = submit(
        book,
        order({ userId: 'buyer', side: 'buy', price: 100n, remaining: 5n }),
      );
      expect(result.fills).toEqual([]);
      expect(book.bestBid()).toBe(100n);
      expect(book.bestAsk()).toBe(101n);
    });

    it('sorts bids high-to-low and asks low-to-high and aggregates levels', () => {
      const book = new OrderBook('BTC-USD');
      for (const price of [99n, 101n, 100n, 100n]) {
        submit(book, order({ userId: 'b', side: 'buy', price, remaining: 1n }));
      }
      for (const price of [105n, 103n, 104n, 103n]) {
        submit(book, order({ userId: 's', side: 'sell', price, remaining: 2n }));
      }
      expect(book.snapshot(10)).toEqual({
        bids: [
          { price: 101n, quantity: 1n, orderCount: 1 },
          { price: 100n, quantity: 2n, orderCount: 2 },
          { price: 99n, quantity: 1n, orderCount: 1 },
        ],
        asks: [
          { price: 103n, quantity: 4n, orderCount: 2 },
          { price: 104n, quantity: 2n, orderCount: 1 },
          { price: 105n, quantity: 2n, orderCount: 1 },
        ],
      });
      expect(book.snapshot(1).bids).toHaveLength(1);
    });
  });

  describe('matching', () => {
    it('fills at the maker price, giving the taker price improvement', () => {
      const book = new OrderBook('BTC-USD');
      const ask = order({ userId: 'seller', side: 'sell', price: 100n, remaining: 5n });
      submit(book, ask);
      const result = submit(
        book,
        order({ userId: 'buyer', side: 'buy', price: 110n, remaining: 5n }),
      );
      expect(result).toEqual({
        fills: [
          {
            makerOrderId: ask.id,
            makerUserId: 'seller',
            price: 100n,
            quantity: 5n,
            makerRemainingAfter: 0n,
          },
        ],
        remaining: 0n,
        outcome: 'filled',
      });
      expect(book.size).toBe(0);
    });

    it('takes better prices first (price priority)', () => {
      const book = new OrderBook('BTC-USD');
      const expensive = order({ userId: 's1', side: 'sell', price: 102n, remaining: 1n });
      const cheap = order({ userId: 's2', side: 'sell', price: 101n, remaining: 1n });
      submit(book, expensive);
      submit(book, cheap);
      const result = submit(book, order({ userId: 'b', side: 'buy', price: 102n, remaining: 1n }));
      expect(result.fills.map((fill) => fill.makerOrderId)).toEqual([cheap.id]);
      expect(book.has(expensive.id)).toBe(true);
    });

    it('takes earlier orders first at the same price (time priority)', () => {
      const book = new OrderBook('BTC-USD');
      const first = order({ userId: 's1', side: 'sell', price: 100n, remaining: 1n });
      const second = order({ userId: 's2', side: 'sell', price: 100n, remaining: 1n });
      submit(book, first);
      submit(book, second);
      const result = submit(book, order({ userId: 'b', side: 'buy', price: 100n, remaining: 1n }));
      expect(result.fills.map((fill) => fill.makerOrderId)).toEqual([first.id]);
      expect(book.has(second.id)).toBe(true);
    });

    it('partially fills a resting order and keeps its place in the queue', () => {
      const book = new OrderBook('BTC-USD');
      const big = order({ userId: 's1', side: 'sell', price: 100n, remaining: 10n });
      const behind = order({ userId: 's2', side: 'sell', price: 100n, remaining: 10n });
      submit(book, big);
      submit(book, behind);
      submit(book, order({ userId: 'b', side: 'buy', price: 100n, remaining: 4n }));
      expect(book.get(big.id)?.remaining).toBe(6n);
      const next = submit(book, order({ userId: 'b', side: 'buy', price: 100n, remaining: 1n }));
      expect(next.fills[0]?.makerOrderId).toBe(big.id);
    });

    it('rests the unfilled part of a partially filled GTC order', () => {
      const book = new OrderBook('BTC-USD');
      submit(book, order({ userId: 's', side: 'sell', price: 100n, remaining: 3n }));
      const buy = order({ userId: 'b', side: 'buy', price: 100n, remaining: 10n });
      const result = submit(book, buy);
      expect(result).toMatchObject({ remaining: 7n, outcome: 'resting' });
      expect(book.get(buy.id)).toMatchObject({ remaining: 7n, price: 100n, side: 'buy' });
    });

    it('expires the unfilled part of a partially filled IOC order', () => {
      const book = new OrderBook('BTC-USD');
      submit(book, order({ userId: 's', side: 'sell', price: 100n, remaining: 3n }));
      const result = submit(
        book,
        order({ userId: 'b', side: 'buy', price: 100n, remaining: 10n, timeInForce: 'IOC' }),
      );
      expect(result).toMatchObject({ remaining: 7n, outcome: 'expired' });
      expect(book.size).toBe(0);
    });

    it('sweeps several levels until its limit price', () => {
      const book = new OrderBook('BTC-USD');
      submit(book, order({ userId: 's', side: 'sell', price: 100n, remaining: 1n }));
      submit(book, order({ userId: 's', side: 'sell', price: 101n, remaining: 1n }));
      submit(book, order({ userId: 's', side: 'sell', price: 102n, remaining: 1n }));
      submit(book, order({ userId: 's', side: 'sell', price: 103n, remaining: 1n }));
      const result = submit(book, order({ userId: 'b', side: 'buy', price: 102n, remaining: 5n }));
      expect(result.fills.map((fill) => fill.price)).toEqual([100n, 101n, 102n]);
      expect(result).toMatchObject({ remaining: 2n, outcome: 'resting' });
      expect(book.bestBid()).toBe(102n);
      expect(book.bestAsk()).toBe(103n);
    });

    it('matches sells against bids from the highest price down', () => {
      const book = new OrderBook('BTC-USD');
      submit(book, order({ userId: 'b', side: 'buy', price: 99n, remaining: 1n }));
      submit(book, order({ userId: 'b', side: 'buy', price: 101n, remaining: 1n }));
      const result = submit(book, order({ userId: 's', side: 'sell', price: 98n, remaining: 2n }));
      expect(result.fills.map((fill) => fill.price)).toEqual([101n, 99n]);
      expect(result.outcome).toBe('filled');
    });
  });

  describe('self-trade prevention', () => {
    it('cancels the incoming order instead of trading with the same user', () => {
      const book = new OrderBook('BTC-USD');
      const own = order({ userId: 'alice', side: 'sell', price: 100n, remaining: 5n });
      submit(book, own);
      const result = submit(
        book,
        order({ userId: 'alice', side: 'buy', price: 100n, remaining: 5n }),
      );
      expect(result).toEqual({ fills: [], remaining: 5n, outcome: 'self_trade_prevented' });
      expect(book.get(own.id)?.remaining).toBe(5n);
      expect(book.bestBid()).toBeNull();
    });

    it('keeps fills against other users that come before the own order', () => {
      const book = new OrderBook('BTC-USD');
      submit(book, order({ userId: 'bob', side: 'sell', price: 100n, remaining: 2n }));
      submit(book, order({ userId: 'alice', side: 'sell', price: 101n, remaining: 2n }));
      submit(book, order({ userId: 'carol', side: 'sell', price: 102n, remaining: 2n }));
      const result = submit(
        book,
        order({ userId: 'alice', side: 'buy', price: 102n, remaining: 6n }),
      );
      expect(result.fills.map((fill) => fill.makerUserId)).toEqual(['bob']);
      expect(result).toMatchObject({ remaining: 4n, outcome: 'self_trade_prevented' });
    });

    it('does not trigger when the order is already filled before reaching its own order', () => {
      const book = new OrderBook('BTC-USD');
      submit(book, order({ userId: 'bob', side: 'sell', price: 100n, remaining: 2n }));
      submit(book, order({ userId: 'alice', side: 'sell', price: 100n, remaining: 2n }));
      const result = submit(
        book,
        order({ userId: 'alice', side: 'buy', price: 100n, remaining: 2n }),
      );
      expect(result.outcome).toBe('filled');
    });
  });

  describe('book maintenance', () => {
    it('removes orders and cleans up empty levels', () => {
      const book = new OrderBook('BTC-USD');
      const a = order({ side: 'buy', price: 100n, remaining: 1n });
      const b = order({ side: 'buy', price: 100n, remaining: 1n });
      submit(book, a);
      submit(book, b);
      expect(book.remove(a.id)).toMatchObject({ id: a.id });
      expect(book.snapshot(5).bids).toEqual([{ price: 100n, quantity: 1n, orderCount: 1 }]);
      book.remove(b.id);
      expect(book.snapshot(5).bids).toEqual([]);
      expect(book.remove('does-not-exist')).toBeUndefined();
    });

    it('rejects duplicate ids and empty orders', () => {
      const book = new OrderBook('BTC-USD');
      const a = order({ side: 'buy', price: 100n, remaining: 1n });
      book.add(a);
      expect(() => book.add(a)).toThrow(/already on the book/);
      expect(() => book.match(a)).toThrow(/already on the book/);
      expect(() => book.add(order({ side: 'buy', price: 100n, remaining: 0n }))).toThrow();
      expect(() => book.match(order({ side: 'buy', price: 100n, remaining: 0n }))).toThrow();
    });

    it('does not let callers mutate book state through references', () => {
      const book = new OrderBook('BTC-USD');
      const a = order({ side: 'buy', price: 100n, remaining: 5n });
      book.add(a);
      a.remaining = 999n;
      const copy = book.get(a.id) as { remaining: bigint };
      copy.remaining = 999n;
      expect(book.get(a.id)?.remaining).toBe(5n);
    });

    it('match() does not modify the book', () => {
      const book = new OrderBook('BTC-USD');
      submit(book, order({ userId: 's', side: 'sell', price: 100n, remaining: 5n }));
      const before = book.snapshot(10);
      book.match(order({ userId: 'b', side: 'buy', price: 100n, remaining: 3n }));
      expect(book.snapshot(10)).toEqual(before);
    });

    it('apply() rejects a stale result without touching the book', () => {
      const book = new OrderBook('BTC-USD');
      const ask = order({ userId: 's', side: 'sell', price: 100n, remaining: 5n });
      submit(book, ask);
      const incoming = order({ userId: 'b', side: 'buy', price: 100n, remaining: 3n });
      const result = book.match(incoming);
      book.remove(ask.id);
      book.add({ ...ask, remaining: 1n });
      expect(() => book.apply(incoming, result)).toThrow(/Stale/);
      expect(book.get(ask.id)?.remaining).toBe(1n);
      expect(book.has(incoming.id)).toBe(false);
    });
  });

  describe('randomized invariants', () => {
    // Deterministic PRNG so a failure is reproducible.
    function mulberry32(seed: number) {
      let state = seed;
      return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    it.each([1, 2, 3, 42, 1337])('holds for 2,000 random orders (seed %i)', (seed) => {
      const random = mulberry32(seed);
      const book = new OrderBook('BTC-USD');
      const users = ['a', 'b', 'c', 'd'];
      let submitted = 0n;
      let filledTwice = 0n;
      let cancelled = 0n;

      for (let i = 0; i < 2_000; i++) {
        const incoming = order({
          userId: users[Math.floor(random() * users.length)]!,
          side: random() < 0.5 ? 'buy' : 'sell',
          price: 95n + BigInt(Math.floor(random() * 11)),
          remaining: 1n + BigInt(Math.floor(random() * 10)),
          timeInForce: random() < 0.2 ? 'IOC' : 'GTC',
        });
        submitted += incoming.remaining;
        const result = submit(book, incoming);

        for (const fill of result.fills) {
          // Never trades with yourself, never outside the taker's limit.
          expect(fill.makerUserId).not.toBe(incoming.userId);
          if (incoming.side === 'buy') expect(fill.price <= incoming.price).toBe(true);
          else expect(fill.price >= incoming.price).toBe(true);
          expect(fill.quantity > 0n).toBe(true);
          filledTwice += 2n * fill.quantity; // both sides of the trade
        }
        if (result.outcome === 'expired' || result.outcome === 'self_trade_prevented') {
          cancelled += result.remaining;
        }

        // The book is never crossed after an order is processed.
        const bid = book.bestBid();
        const ask = book.bestAsk();
        if (bid !== null && ask !== null) expect(bid < ask).toBe(true);
      }

      // Conservation: every unit submitted was either traded, cancelled, or is still resting.
      const { bids, asks } = book.snapshot(1_000);
      const resting = [...bids, ...asks].reduce((sum, level) => sum + level.quantity, 0n);
      expect(filledTwice + cancelled + resting).toBe(submitted);
    });
  });
});
