import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import WebSocket from 'ws';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ServerMessage } from '@pte/shared';
import { createApp } from '../src/app.ts';
import { RealtimeHub } from '../src/realtime/hub.ts';
import { createTestContext, createTrader, limitOrder, resetDatabase } from './helpers.ts';

const ctx = createTestContext();
const app = createApp(ctx, { rateLimit: false });
const server = http.createServer(app);
const hub = new RealtimeHub(ctx);
hub.attach(server);
let baseUrl = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await resetDatabase(ctx.pool);
  await ctx.orderService.loadOpenOrders();
});

afterAll(async () => {
  hub.close();
  await new Promise((resolve) => server.close(resolve));
  await ctx.pool.end();
});

interface TestSocket {
  socket: WebSocket;
  messages: ServerMessage[];
  waitFor<T extends ServerMessage['type']>(
    type: T,
    predicate?: (message: Extract<ServerMessage, { type: T }>) => boolean,
  ): Promise<Extract<ServerMessage, { type: T }>>;
  closed: Promise<number>;
}

async function connect(cookie?: string): Promise<TestSocket> {
  const socket = new WebSocket(`ws://${baseUrl}/ws`, cookie ? { headers: { Cookie: cookie } } : {});
  const messages: ServerMessage[] = [];
  const waiters: Array<() => void> = [];
  socket.on('message', (data) => {
    messages.push(JSON.parse(data.toString()) as ServerMessage);
    for (const wake of waiters.splice(0)) wake();
  });
  const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  function waitFor<T extends ServerMessage['type']>(
    type: T,
    predicate: (message: Extract<ServerMessage, { type: T }>) => boolean = () => true,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 3_000);
      const check = () => {
        const found = messages.find(
          (message): message is Extract<ServerMessage, { type: T }> =>
            message.type === type && predicate(message as Extract<ServerMessage, { type: T }>),
        );
        if (found) {
          clearTimeout(timeout);
          resolve(found);
        } else {
          waiters.push(check);
        }
      };
      check();
    });
  }

  return { socket, messages, waitFor, closed };
}

async function loginCookie(email: string): Promise<string> {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123', displayName: email.split('@')[0] })
    .expect(201);
  return response.headers['set-cookie']![0]!.split(';')[0]!;
}

describe('realtime hub', () => {
  it('sends ticker, book and recent trades when a client subscribes', async () => {
    const client = await connect();
    client.socket.send(JSON.stringify({ type: 'subscribe', market: 'BTC-USD' }));

    expect((await client.waitFor('ticker')).ticker).toMatchObject({
      market: 'BTC-USD',
      referencePrice: '50000',
      stale: false,
    });
    expect((await client.waitFor('book')).book).toEqual({ market: 'BTC-USD', bids: [], asks: [] });
    expect(await client.waitFor('trades')).toEqual({
      type: 'trades',
      market: 'BTC-USD',
      trades: [],
    });
    client.socket.close();
  });

  it('broadcasts trades and book changes to subscribers', async () => {
    const seller = await createTrader(ctx.pool, { BTC: '1' });
    const buyer = await createTrader(ctx.pool);
    const client = await connect();
    client.socket.send(JSON.stringify({ type: 'subscribe', market: 'BTC-USD' }));
    await client.waitFor('trades');

    await ctx.orderService.placeOrder(seller.id, limitOrder('BTC-USD', 'sell', '50000', '0.3'));
    await client.waitFor('book', (m) => m.book.asks.length === 1);
    await ctx.orderService.placeOrder(buyer.id, limitOrder('BTC-USD', 'buy', '50000', '0.1'));

    const trade = await client.waitFor('trade');
    expect(trade.trade).toMatchObject({
      market: 'BTC-USD',
      price: '50000',
      quantity: '0.1',
      takerSide: 'buy',
    });
    // Public trade messages must not reveal who traded or which orders were involved.
    expect(Object.keys(trade.trade).sort()).toEqual([
      'createdAt',
      'id',
      'market',
      'price',
      'quantity',
      'takerSide',
    ]);
    await client.waitFor('book', (m) => m.book.asks[0]?.quantity === '0.2');
    client.socket.close();
  });

  it('sends private fills and balances only to the user involved', async () => {
    const cookie = await loginCookie('alice@example.com');
    const seller = await createTrader(ctx.pool, { BTC: '1' });
    const alice = await connect(cookie);
    const stranger = await connect();
    for (const client of [alice, stranger]) {
      client.socket.send(JSON.stringify({ type: 'subscribe', market: 'BTC-USD' }));
      await client.waitFor('trades');
    }

    await ctx.orderService.placeOrder(seller.id, limitOrder('BTC-USD', 'sell', '50000', '0.1'));
    await request(app)
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({ type: 'limit', market: 'BTC-USD', side: 'buy', price: '50000', quantity: '0.1' })
      .expect(201);

    expect((await alice.waitFor('fill')).fill).toMatchObject({
      side: 'buy',
      role: 'taker',
      quantity: '0.1',
    });
    expect((await alice.waitFor('order')).order).toMatchObject({ status: 'filled' });
    const balances = await alice.waitFor('balances');
    expect(balances.balances).toContainEqual({ asset: 'BTC', available: '0.1', held: '0' });

    await stranger.waitFor('trade');
    expect(stranger.messages.some((m) => ['fill', 'order', 'balances'].includes(m.type))).toBe(
      false,
    );
    alice.socket.close();
    stranger.socket.close();
  });

  it('rejects junk messages without dropping the connection', async () => {
    const client = await connect();
    client.socket.send('not json');
    expect((await client.waitFor('error')).message).toBe('Messages must be JSON');
    client.socket.send(JSON.stringify({ type: 'subscribe', market: 'DOGE-USD' }));
    await client.waitFor('error', (m) => m.message === 'Unsupported message');
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    client.socket.close();
  });

  it('closes a logged-in socket when that session logs out', async () => {
    const cookie = await loginCookie('bob@example.com');
    const client = await connect(cookie);
    await request(app).post('/api/auth/logout').set('Cookie', cookie).expect(204);
    expect(await client.closed).toBe(4001);
  });
});
