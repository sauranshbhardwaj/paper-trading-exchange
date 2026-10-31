import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { createTestContext, createTrader, resetDatabase } from './helpers.ts';

const ctx = createTestContext();
const app = createApp(ctx, { rateLimit: false });

beforeEach(async () => {
  await resetDatabase(ctx.pool);
  await ctx.orderService.loadOpenOrders();
});

afterAll(async () => {
  await ctx.pool.end();
});

const ALICE = { email: 'alice@example.com', password: 'password123', displayName: 'alice' };

async function registeredAgent(user = ALICE) {
  const agent = request.agent(app);
  await agent.post('/api/auth/register').send(user).expect(201);
  return agent;
}

describe('auth', () => {
  it('registers with $100,000, sets an httpOnly session cookie, and logs in', async () => {
    const response = await request(app).post('/api/auth/register').send(ALICE).expect(201);
    expect(response.body.user).toEqual({
      id: '1',
      email: 'alice@example.com',
      displayName: 'alice',
    });
    const cookie = response.headers['set-cookie']?.[0] ?? '';
    expect(cookie).toMatch(/^pte_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);

    const balances = await request(app).get('/api/balances').set('Cookie', cookie).expect(200);
    expect(balances.body.balances).toEqual([
      { asset: 'USD', available: '100000', held: '0' },
      { asset: 'BTC', available: '0', held: '0' },
      { asset: 'ETH', available: '0', held: '0' },
    ]);
  });

  it('never stores the password in plain text', async () => {
    await request(app).post('/api/auth/register').send(ALICE).expect(201);
    const { rows } = await ctx.pool.query('SELECT password_hash FROM users');
    expect(rows[0].password_hash).toMatch(/^scrypt\$/);
    expect(rows[0].password_hash).not.toContain(ALICE.password);
  });

  it('rejects duplicate emails (case-insensitive) and duplicate display names', async () => {
    await request(app).post('/api/auth/register').send(ALICE).expect(201);
    const sameEmail = await request(app)
      .post('/api/auth/register')
      .send({ ...ALICE, email: 'ALICE@example.com', displayName: 'alice2' })
      .expect(409);
    expect(sameEmail.body.error).toMatchObject({
      code: 'EMAIL_TAKEN',
      fields: { email: expect.any(String) },
    });

    const sameName = await request(app)
      .post('/api/auth/register')
      .send({ ...ALICE, email: 'other@example.com', displayName: 'ALICE' })
      .expect(409);
    expect(sameName.body.error.code).toBe('DISPLAY_NAME_TAKEN');
  });

  it('returns field errors for invalid input', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ email: 'nope', password: 'short', displayName: '!' })
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(response.body.error.fields).sort()).toEqual([
      'displayName',
      'email',
      'password',
    ]);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    await request(app).post('/api/auth/register').send(ALICE).expect(201);
    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: ALICE.email, password: 'wrong-password' })
      .expect(401);
    const unknownEmail = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ghost@example.com', password: 'wrong-password' })
      .expect(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
  });

  it('logs out by deleting the session server-side', async () => {
    const agent = await registeredAgent();
    await agent.get('/api/auth/me').expect(200);
    await agent.post('/api/auth/logout').expect(204);
    await agent.get('/api/auth/me').expect(401);
    const { rows } = await ctx.pool.query('SELECT count(*)::int AS n FROM sessions');
    expect(rows[0].n).toBe(0);
  });

  it('ignores forged session cookies', async () => {
    await request(app).get('/api/auth/me').set('Cookie', 'pte_session=forged').expect(401);
  });
});

describe('orders over HTTP', () => {
  it('places, lists and cancels an order', async () => {
    const agent = await registeredAgent();
    const placed = await agent
      .post('/api/orders')
      .send({ type: 'limit', market: 'BTC-USD', side: 'buy', price: '49000', quantity: '0.01' })
      .expect(201);
    expect(placed.body.order).toMatchObject({ status: 'open', price: '49000', quantity: '0.01' });

    const open = await agent.get('/api/orders?status=open').expect(200);
    expect(open.body.orders).toHaveLength(1);

    await agent.delete(`/api/orders/${placed.body.order.id}`).expect(200);
    expect((await agent.get('/api/orders?status=open').expect(200)).body.orders).toEqual([]);
    expect((await agent.get('/api/orders?status=closed').expect(200)).body.orders).toHaveLength(1);
  });

  it('trades between two users through the API', async () => {
    const seller = await createTrader(ctx.pool, { BTC: '1' });
    await ctx.orderService.placeOrder(seller.id, {
      type: 'limit',
      market: 'BTC-USD',
      side: 'sell',
      price: 5_000_000n,
      quantity: 1_000_000n,
    });
    const agent = await registeredAgent();
    const response = await agent
      .post('/api/orders')
      .send({ type: 'market', market: 'BTC-USD', side: 'buy', quantity: '0.01' })
      .expect(201);
    expect(response.body.order).toMatchObject({ status: 'filled', filledQuantity: '0.01' });

    const balances = await agent.get('/api/balances').expect(200);
    expect(balances.body.balances).toContainEqual({ asset: 'BTC', available: '0.01', held: '0' });
    expect(balances.body.balances).toContainEqual({ asset: 'USD', available: '99500', held: '0' });
  });

  it.each([
    [
      { type: 'limit', market: 'BTC-USD', side: 'buy', price: '49000.001', quantity: '0.01' },
      'VALIDATION_ERROR',
    ],
    [
      { type: 'limit', market: 'BTC-USD', side: 'buy', price: 49000, quantity: '0.01' },
      'VALIDATION_ERROR',
    ],
    [
      { type: 'limit', market: 'BTC-USD', side: 'buy', price: '10', quantity: '0.01' },
      'PRICE_OUT_OF_BAND',
    ],
    [
      { type: 'limit', market: 'BTC-USD', side: 'buy', price: '50000', quantity: '0.000015' },
      'INVALID_QUANTITY',
    ],
    [
      { type: 'limit', market: 'BTC-USD', side: 'buy', price: '50000', quantity: '0.00001' },
      'BELOW_MIN_NOTIONAL',
    ],
    [
      { type: 'limit', market: 'BTC-USD', side: 'buy', price: '50000', quantity: '100' },
      'INSUFFICIENT_FUNDS',
    ],
  ])('rejects %j with %s', async (body, code) => {
    const agent = await registeredAgent();
    const response = await agent.post('/api/orders').send(body).expect(400);
    expect(response.body.error.code).toBe(code);
    expect(response.body.error.message).toEqual(expect.any(String));
  });

  it('rejects malformed JSON and unknown order ids cleanly', async () => {
    const agent = await registeredAgent();
    const malformed = await agent
      .post('/api/orders')
      .set('Content-Type', 'application/json')
      .send('{"type":')
      .expect(400);
    expect(malformed.body.error.code).toBe('INVALID_JSON');
    await agent.delete('/api/orders/abc').expect(400);
    await agent.delete('/api/orders/999').expect(404);
  });

  it('requires login for private endpoints', async () => {
    for (const path of ['/api/balances', '/api/orders']) {
      const response = await request(app).get(path).expect(401);
      expect(response.body.error.code).toBe('UNAUTHORIZED');
    }
    await request(app).post('/api/orders').send({}).expect(401);
  });
});

describe('misc', () => {
  it('reports health', async () => {
    const response = await request(app).get('/api/health').expect(200);
    expect(response.body).toEqual({
      ok: true,
      database: true,
      priceFeed: { 'BTC-USD': true, 'ETH-USD': true },
    });
  });

  it('returns JSON 404s for unknown API routes and sets security headers', async () => {
    const response = await request(app).get('/api/does-not-exist').expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});
