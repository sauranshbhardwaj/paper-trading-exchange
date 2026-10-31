import type { Request, RequestHandler } from 'express';
import { unauthorized } from '../errors.ts';
import type { Pool } from '../db/pool.ts';
import { findUserBySessionToken, readSessionToken } from './sessions.ts';
import type { AuthUser } from './users.ts';

/** Attaches req.user when the session cookie is valid. Never rejects on its own. */
export function authenticate(pool: Pool): RequestHandler {
  return async (req, _res, next) => {
    const token = readSessionToken(req.headers.cookie);
    if (token) {
      const user = await findUserBySessionToken(pool, token);
      if (user) {
        req.user = user;
        req.sessionToken = token;
      }
    }
    next();
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  next(req.user ? undefined : unauthorized());
};

/** For handlers behind requireAuth: the logged-in user, with a type that isn't optional. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
