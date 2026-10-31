import { rateLimit } from 'express-rate-limit';
import type { Request, RequestHandler } from 'express';
import type { ApiErrorBody } from '@pte/shared';

const TOO_MANY: ApiErrorBody = {
  error: {
    code: 'RATE_LIMITED',
    message: 'Too many requests. Please wait a moment and try again.',
  },
};

const passThrough: RequestHandler = (_req, _res, next) => next();

/**
 * Rate limiter that answers in our standard error shape. Disabled in tests so
 * suites can make many requests quickly. Keys by user id when one is given,
 * otherwise by client IP.
 */
export function rateLimiter(options: {
  enabled: boolean;
  windowMs: number;
  limit: number;
  keyByUser?: boolean;
}): RequestHandler {
  if (!options.enabled) return passThrough;
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(options.keyByUser
      ? { keyGenerator: (req: Request) => `user:${req.user?.id ?? 'anonymous'}` }
      : {}),
    handler: (_req, res) => {
      res.status(429).json(TOO_MANY);
    },
  });
}
