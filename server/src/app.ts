import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { HealthDto } from '@pte/shared';
import { authenticate } from './auth/middleware.ts';
import { authRouter } from './auth/routes.ts';
import type { AppContext } from './context.ts';
import { errorHandler, notFound } from './errors.ts';
import { tradingRouter } from './trading/routes.ts';

const CLIENT_DIST = path.resolve(import.meta.dirname, '../../client/dist');

export interface AppOptions {
  rateLimit?: boolean;
}

export function createApp(ctx: AppContext, options: AppOptions = {}): Express {
  const rateLimit = options.rateLimit ?? true;
  const app = express();

  // Render terminates HTTPS at its proxy; trust it so req.ip and secure cookies work.
  if (ctx.config.isProduction) app.set('trust proxy', 1);

  app.use(
    helmet({
      // Render already serves HTTPS; this directive would break local production testing over http.
      contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } },
    }),
  );
  app.use(express.json({ limit: '10kb' }));

  app.get('/api/health', async (_req, res) => {
    const database = await ctx.pool
      .query('SELECT 1')
      .then(() => true)
      .catch(() => false);
    const body: HealthDto = { ok: database, database, priceFeed: ctx.prices.freshness() };
    res.status(database ? 200 : 503).json(body);
  });

  app.use('/api', authenticate(ctx.pool));
  app.use('/api/auth', authRouter(ctx, { rateLimit }));
  app.use('/api', tradingRouter(ctx, { rateLimit }));
  app.use('/api', (_req, _res, next) => next(notFound('Endpoint')));

  // In production the API server also serves the built React app.
  if (ctx.config.isProduction && existsSync(CLIENT_DIST)) {
    app.use(express.static(CLIENT_DIST));
    app.get('/{*path}', (_req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
