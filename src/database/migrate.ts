import type { Migration } from './migrations';

export interface MigrationClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

const LOCK_KEY = 727_274;

export async function runMigrations(
  client: MigrationClient,
  migrations: Migration[],
  log: (message: string) => void = () => undefined,
): Promise<string[]> {
  const applied: string[] = [];
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         id text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const done = await client.query('SELECT id FROM schema_migrations');
    const seen = new Set<string>(
      done.rows.map((row: { id: string }) => row.id),
    );

    for (const migration of migrations) {
      if (seen.has(migration.id)) continue;
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [
          migration.id,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      applied.push(migration.id);
      log(`Applied migration ${migration.id}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
  }
  return applied;
}
