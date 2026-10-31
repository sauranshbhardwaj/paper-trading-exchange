/**
 * Minimal migration runner: applies server/migrations/*.sql in filename order,
 * each in its own transaction, and records what ran in schema_migrations.
 * Run directly with `npm run db:migrate`; the server also runs it on boot.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, withTransaction, type Pool } from './pool.ts';

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../migrations');
// Arbitrary constant: an advisory lock stops two server instances migrating at once.
const MIGRATION_LOCK_ID = 375_001;

export async function migrate(pool: Pool, directory = MIGRATIONS_DIR): Promise<string[]> {
  const lockClient = await pool.connect();
  try {
    await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await lockClient.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
    const { rows } = await lockClient.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.name));

    const ran: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(directory, file), 'utf8');
      await withTransaction(pool, async (client) => {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      });
      ran.push(file);
    }
    return ran;
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    lockClient.release();
  }
}

const isEntryPoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
    process.exit(1);
  }
  const pool = createPool(url);
  try {
    const ran = await migrate(pool);
    console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date.');
  } finally {
    await pool.end();
  }
}
