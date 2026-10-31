import { describe, expect, it } from 'vitest';
import { CoinbaseFeed } from './coinbaseFeed.ts';
import { PriceBoard } from './priceBoard.ts';

function boardWithClock(start = 1_000_000) {
  const clock = { now: start };
  const board = new PriceBoard({ maxAgeMs: 60_000, now: () => clock.now });
  return { board, clock };
}

describe('PriceBoard', () => {
  it('returns null before any price arrives', () => {
    const { board } = boardWithClock();
    expect(board.getReferencePrice('BTC-USD')).toBeNull();
    expect(board.getTicker('BTC-USD')).toEqual({
      market: 'BTC-USD',
      referencePrice: null,
      updatedAt: null,
      stale: true,
    });
  });

  it('serves fresh prices and treats old ones as unavailable', () => {
    const { board, clock } = boardWithClock();
    board.set('BTC-USD', 7_739_414n);
    expect(board.getReferencePrice('BTC-USD')).toBe(7_739_414n);
    expect(board.getTicker('BTC-USD')).toMatchObject({ referencePrice: '77394.14', stale: false });

    clock.now += 60_001;
    expect(board.getReferencePrice('BTC-USD')).toBeNull();
    expect(board.getTicker('BTC-USD')).toMatchObject({ referencePrice: '77394.14', stale: true });
  });

  it('confirmAll keeps quiet-but-alive markets fresh and announces recovery', () => {
    const { board, clock } = boardWithClock();
    board.set('ETH-USD', 225_000n);
    clock.now += 61_000;
    const updates: string[] = [];
    board.on('update', (market) => updates.push(market));
    board.confirmAll();
    expect(board.getReferencePrice('ETH-USD')).toBe(225_000n);
    expect(updates).toEqual(['ETH-USD']);
  });

  it('ignores non-positive prices', () => {
    const { board } = boardWithClock();
    board.set('BTC-USD', 0n);
    expect(board.getReferencePrice('BTC-USD')).toBeNull();
  });
});

describe('CoinbaseFeed.handleMessage', () => {
  // Captured from wss://advanced-trade-ws.coinbase.com
  const tickerMessage = JSON.stringify({
    channel: 'ticker',
    timestamp: '2026-10-31T22:52:11.747176834Z',
    sequence_num: 0,
    events: [
      {
        type: 'snapshot',
        tickers: [
          { type: 'ticker', product_id: 'BTC-USD', price: '77394.14', volume_24_h: '2609.4' },
          { type: 'ticker', product_id: 'SOL-USD', price: '150.00' },
        ],
      },
    ],
  });

  it('updates the board from ticker messages for known markets only', () => {
    const { board } = boardWithClock();
    const feed = new CoinbaseFeed(board);
    feed.handleMessage(tickerMessage);
    expect(board.getReferencePrice('BTC-USD')).toBe(7_739_414n);
    expect(board.getReferencePrice('ETH-USD')).toBeNull();
  });

  it('truncates prices with more precision than cents', () => {
    const { board } = boardWithClock();
    new CoinbaseFeed(board).handleMessage(
      JSON.stringify({
        channel: 'ticker',
        events: [{ tickers: [{ product_id: 'ETH-USD', price: '2249.8765' }] }],
      }),
    );
    expect(board.getReferencePrice('ETH-USD')).toBe(224_987n);
  });

  it('ignores garbage, subscription acks and malformed prices without throwing', () => {
    const { board } = boardWithClock();
    const feed = new CoinbaseFeed(board);
    for (const raw of [
      'not json',
      '{"channel":"subscriptions","events":[]}',
      '{"channel":"ticker","events":[{"tickers":[{"product_id":"BTC-USD","price":"-1"}]}]}',
      '{"channel":"ticker","events":"nope"}',
      'null',
    ]) {
      expect(() => feed.handleMessage(raw)).not.toThrow();
    }
    expect(board.getReferencePrice('BTC-USD')).toBeNull();
  });

  it('treats heartbeats as confirmation that prices are still current', () => {
    const { board, clock } = boardWithClock();
    const feed = new CoinbaseFeed(board);
    feed.handleMessage(tickerMessage);
    clock.now += 61_000;
    feed.handleMessage('{"channel":"heartbeats","events":[{"heartbeat_counter":"5"}]}');
    expect(board.getReferencePrice('BTC-USD')).toBe(7_739_414n);
  });
});
