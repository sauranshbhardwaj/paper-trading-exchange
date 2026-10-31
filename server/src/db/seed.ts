/**
 * Development seed: two demo traders so you can trade against yourself in two
 * browser windows (one normal, one incognito) before the market-making bot exists.
 * Real users start with cash only; the demo users also get coins so they have
 * something to sell. Safe to run repeatedly; refuses to run in production.
 */
import { ASSET_DECIMALS, parseUnits, registerSchema, STARTING_CASH } from '@pte/shared';
import { registerUser } from '../auth/users.ts';
import { AppError } from '../errors.ts';
import { createPool } from './pool.ts';
import { migrate } from './migrate.ts';

const DEMO_PASSWORD = 'password123';
const DEMO_BALANCES = {
  USD: STARTING_CASH,
  BTC: parseUnits('1', ASSET_DECIMALS.BTC),
  ETH: parseUnits('10', ASSET_DECIMALS.ETH),
};
const DEMO_USERS = [
  { email: 'alice@example.com', displayName: 'alice' },
  { email: 'bob@example.com', displayName: 'bob' },
];

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo users in production.');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
  process.exit(1);
}

const pool = createPool(url);
try {
  await migrate(pool);
  for (const demo of DEMO_USERS) {
    try {
      await registerUser(pool, registerSchema.parse({ ...demo, password: DEMO_PASSWORD }), {
        startingBalances: DEMO_BALANCES,
      });
      console.log(`Created ${demo.email} / ${DEMO_PASSWORD}`);
    } catch (error) {
      if (error instanceof AppError && error.status === 409) {
        console.log(`${demo.email} already exists`);
      } else {
        throw error;
      }
    }
  }
} finally {
  await pool.end();
}
