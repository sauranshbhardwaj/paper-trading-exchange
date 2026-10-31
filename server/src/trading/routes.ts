import { Router } from 'express';
import { listOrdersQuerySchema, orderIdParamSchema, placeOrderSchema } from '@pte/shared';
import type { AppContext } from '../context.ts';
import { currentUser, requireAuth } from '../auth/middleware.ts';
import { rateLimiter } from '../http/rateLimit.ts';
import { listBalances, toBalanceDto } from './balancesRepo.ts';
import { listOrdersForUser, toOrderDto } from './ordersRepo.ts';

export function tradingRouter(ctx: AppContext, options: { rateLimit: boolean }): Router {
  const router = Router();
  // Generous for humans, but stops a script from flooding the book: 60 orders per 10s per user.
  const orderLimiter = rateLimiter({
    enabled: options.rateLimit,
    windowMs: 10_000,
    limit: 60,
    keyByUser: true,
  });

  router.get('/balances', requireAuth, async (req, res) => {
    const balances = await listBalances(ctx.pool, currentUser(req).id);
    res.json({ balances: balances.map(toBalanceDto) });
  });

  router.get('/orders', requireAuth, async (req, res) => {
    const filter = listOrdersQuerySchema.parse(req.query);
    const orders = await listOrdersForUser(ctx.pool, currentUser(req).id, filter);
    res.json({ orders: orders.map(toOrderDto) });
  });

  router.post('/orders', requireAuth, orderLimiter, async (req, res) => {
    const input = placeOrderSchema.parse(req.body);
    const order = await ctx.orderService.placeOrder(currentUser(req).id, input);
    res.status(201).json({ order });
  });

  router.delete('/orders/:id', requireAuth, async (req, res) => {
    const { id } = orderIdParamSchema.parse(req.params);
    const order = await ctx.orderService.cancelOrder(currentUser(req).id, id);
    res.json({ order });
  });

  return router;
}
