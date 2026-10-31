import { createPool } from '../src/db/pool.ts';
import { migrate } from '../src/db/migrate.ts';
import { TEST_DATABASE_URL } from './helpers.ts';

export default async function setup(): Promise<void> {
  const pool = createPool(TEST_DATABASE_URL);
  try {
    await migrate(pool);
  } catch (error) {
    throw new Error(
      `Could not prepare the test database at ${TEST_DATABASE_URL}. Is Postgres running? Try \`npm run db:up\`.`,
      { cause: error },
    );
  } finally {
    await pool.end();
  }
}
