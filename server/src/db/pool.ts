import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
/** Anything you can run a query on: the pool, or a client inside a transaction. */
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // An idle client can error (e.g. the DB restarted). Without this listener Node would crash.
  pool.on('error', (error) => console.error('[db] idle client error:', error.message));
  return pool;
}

/**
 * Run `work` inside BEGIN/COMMIT. Any thrown error rolls everything back, so
 * a trade is either saved completely or not at all.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let connectionBroken = false;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      connectionBroken = true;
    }
    throw error;
  } finally {
    // Passing `true` destroys a broken connection instead of returning it to the pool.
    client.release(connectionBroken);
  }
}

const PG_UNIQUE_VIOLATION = '23505';

export function uniqueViolationConstraint(error: unknown): string | null {
  if (error instanceof pg.DatabaseError && error.code === PG_UNIQUE_VIOLATION) {
    return error.constraint ?? null;
  }
  return null;
}
