import type { AuthUser } from '../auth/users.ts';

declare global {
  namespace Express {
    interface Request {
      /** Set by the authenticate middleware when the session cookie is valid. */
      user?: AuthUser;
      sessionToken?: string;
    }
  }
}

export {};
