import { runMigrations, type MigrationClient } from './migrate';
import { MIGRATIONS } from './migrations';

function fakeClient(applied: string[]) {
  const statements: string[] = [];
  const client: MigrationClient = {
    query: async (text: string, values?: unknown[]) => {
      statements.push(text.trim().split('\n')[0].trim());
      if (text.startsWith('SELECT id FROM schema_migrations')) {
        return { rows: applied.map((id) => ({ id })) };
      }
      if (text.startsWith('INSERT INTO schema_migrations'))
        applied.push(String(values?.[0]));
      return { rows: [] };
    },
  };
  return { client, statements };
}

describe('runMigrations', () => {
  it('applies pending migrations once, inside transactions', async () => {
    const applied: string[] = [];
    const { client, statements } = fakeClient(applied);

    expect(await runMigrations(client, MIGRATIONS)).toEqual(
      MIGRATIONS.map((m) => m.id),
    );
    expect(statements).toContain('BEGIN');
    expect(statements).toContain('COMMIT');
    expect(applied).toEqual(MIGRATIONS.map((m) => m.id));

    expect(await runMigrations(client, MIGRATIONS)).toEqual([]);
  });

  it('rolls back and releases the lock when a migration fails', async () => {
    const statements: string[] = [];
    const client: MigrationClient = {
      query: async (text: string) => {
        statements.push(text.trim().split('\n')[0].trim());
        if (text.includes('BROKEN')) throw new Error('boom');
        return { rows: [] };
      },
    };

    await expect(
      runMigrations(client, [{ id: '999_bad', sql: 'BROKEN' }]),
    ).rejects.toThrow('boom');
    expect(statements).toContain('ROLLBACK');
    expect(statements[statements.length - 1]).toContain('pg_advisory_unlock');
  });

  it('has unique, ordered migration ids', () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });
});
