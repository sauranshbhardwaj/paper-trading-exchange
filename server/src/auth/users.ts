import type { Asset, registerSchema, UserDto } from '@pte/shared';
import type { z } from 'zod';
import { AppError } from '../errors.ts';
import {
  uniqueViolationConstraint,
  withTransaction,
  type Pool,
  type Queryable,
} from '../db/pool.ts';
import { createStartingBalances } from '../trading/balancesRepo.ts';
import { hashPassword } from './password.ts';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  isBot: boolean;
}

export type RegisterData = z.output<typeof registerSchema>;

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  is_bot: boolean;
  password_hash: string;
}

function toAuthUser(row: UserRow): AuthUser {
  return { id: row.id, email: row.email, displayName: row.display_name, isBot: row.is_bot };
}

export function toUserDto(user: AuthUser): UserDto {
  return { id: user.id, email: user.email, displayName: user.displayName };
}

/**
 * Create a user and their starting balances in one transaction, so there is
 * never a user without balance rows.
 */
export async function registerUser(
  pool: Pool,
  input: RegisterData,
  options: { isBot?: boolean; startingBalances?: Partial<Record<Asset, bigint>> } = {},
): Promise<AuthUser> {
  const passwordHash = await hashPassword(input.password);
  try {
    return await withTransaction(pool, async (client) => {
      const { rows } = await client.query<UserRow>(
        `INSERT INTO users (email, password_hash, display_name, is_bot)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, display_name, is_bot, password_hash`,
        [input.email, passwordHash, input.displayName, options.isBot ?? false],
      );
      const user = toAuthUser(rows[0]!);
      await createStartingBalances(client, user.id, options.startingBalances);
      return user;
    });
  } catch (error) {
    const constraint = uniqueViolationConstraint(error);
    if (constraint === 'users_email_key') {
      throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists', {
        email: 'An account with this email already exists',
      });
    }
    if (constraint === 'users_display_name_key') {
      throw new AppError(409, 'DISPLAY_NAME_TAKEN', 'That display name is taken', {
        displayName: 'That display name is taken',
      });
    }
    throw error;
  }
}

export async function findUserByEmail(
  db: Queryable,
  email: string,
): Promise<(AuthUser & { passwordHash: string }) | null> {
  const { rows } = await db.query<UserRow>(
    'SELECT id, email, display_name, is_bot, password_hash FROM users WHERE email = $1',
    [email],
  );
  const row = rows[0];
  return row ? { ...toAuthUser(row), passwordHash: row.password_hash } : null;
}
