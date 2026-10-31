/**
 * Cookie sessions. The browser holds a random token in an httpOnly cookie
 * (JavaScript can't read it, so XSS can't steal it). The database stores only
 * a SHA-256 of the token, so a leaked sessions table can't be used to log in.
 */
import { createHash, randomBytes } from 'node:crypto';
import { parse as parseCookies } from 'cookie';
import type { CookieOptions } from 'express';
import type { Queryable } from '../db/pool.ts';
import type { AuthUser } from './users.ts';

export const SESSION_COOKIE = 'pte_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function sessionCookieOptions(isProduction: boolean): CookieOptions {
  return {
    httpOnly: true,
    // "lax" stops other sites from sending our cookie with POST/DELETE requests (CSRF).
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
    maxAge: SESSION_TTL_MS,
  };
}

export function readSessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  return parseCookies(cookieHeader)[SESSION_COOKIE] ?? null;
}

export async function createSession(db: Queryable, userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query('DELETE FROM sessions WHERE user_id = $1 AND expires_at < now()', [userId]);
  await db.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
    hashToken(token),
    userId,
    new Date(Date.now() + SESSION_TTL_MS),
  ]);
  return token;
}

interface SessionUserRow {
  id: string;
  email: string;
  display_name: string;
  is_bot: boolean;
}

export async function findUserBySessionToken(
  db: Queryable,
  token: string,
): Promise<AuthUser | null> {
  const { rows } = await db.query<SessionUserRow>(
    `SELECT u.id, u.email, u.display_name, u.is_bot
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  const row = rows[0];
  return row
    ? { id: row.id, email: row.email, displayName: row.display_name, isBot: row.is_bot }
    : null;
}

export async function deleteSession(db: Queryable, token: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}
