import { Router, type Response } from 'express';
import { loginSchema, registerSchema } from '@pte/shared';
import type { AppContext } from '../context.ts';
import { AppError } from '../errors.ts';
import { rateLimiter } from '../http/rateLimit.ts';
import { dummyPasswordHash, verifyPassword } from './password.ts';
import {
  createSession,
  deleteSession,
  hashToken,
  SESSION_COOKIE,
  sessionCookieOptions,
} from './sessions.ts';
import { findUserByEmail, registerUser, toUserDto, type AuthUser } from './users.ts';

const INVALID_CREDENTIALS = 'Invalid email or password';

export function authRouter(ctx: AppContext, options: { rateLimit: boolean }): Router {
  const router = Router();
  // Slows down password guessing: 20 attempts per 15 minutes per IP.
  const limiter = rateLimiter({ enabled: options.rateLimit, windowMs: 15 * 60_000, limit: 20 });

  async function startSession(res: Response, user: AuthUser): Promise<void> {
    const token = await createSession(ctx.pool, user.id);
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions(ctx.config.isProduction));
  }

  router.post('/register', limiter, async (req, res) => {
    const input = registerSchema.parse(req.body);
    const user = await registerUser(ctx.pool, input);
    await startSession(res, user);
    res.status(201).json({ user: toUserDto(user) });
  });

  router.post('/login', limiter, async (req, res) => {
    const input = loginSchema.parse(req.body);
    const user = await findUserByEmail(ctx.pool, input.email);
    const passwordOk = await verifyPassword(
      input.password,
      user?.passwordHash ?? (await dummyPasswordHash()),
    );
    // Bot accounts are driven by the server and must never be logged into.
    if (!user || !passwordOk || user.isBot) {
      throw new AppError(401, 'INVALID_CREDENTIALS', INVALID_CREDENTIALS);
    }
    await startSession(res, user);
    res.json({ user: toUserDto(user) });
  });

  router.post('/logout', async (req, res) => {
    if (req.sessionToken) {
      await deleteSession(ctx.pool, req.sessionToken);
      ctx.events.emit('sessionEnded', hashToken(req.sessionToken));
    }
    res.clearCookie(SESSION_COOKIE, {
      ...sessionCookieOptions(ctx.config.isProduction),
      maxAge: undefined,
    });
    res.status(204).end();
  });

  // A session check, not a protected resource: anonymous visitors get { user: null }
  // instead of a 401, so the browser console isn't full of red errors on every page load.
  router.get('/me', (req, res) => {
    res.json({ user: req.user ? toUserDto(req.user) : null });
  });

  return router;
}
