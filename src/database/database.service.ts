import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Pool } from 'pg';
import { AppConfig } from '../config/app-config';
import { Executor, type Db } from './executor';
import { runMigrations } from './migrate';
import { MIGRATIONS } from './migrations';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool: Pool;
  private readonly executor: Executor;

  constructor(private readonly config: AppConfig) {
    this.pool = new Pool({
      connectionString: config.get('DATABASE_URL'),
      max: 10,
      connectionTimeoutMillis: 5000,
    });
    this.pool.on('error', (error) => {
      this.logger.error(`Idle database client error: ${error.message}`);
    });
    this.executor = new Executor(this.pool);
  }

  async onModuleInit(): Promise<void> {
    try {
      if (this.config.get('MIGRATE_ON_BOOT')) await this.migrate();
      else await this.pool.query('SELECT 1');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Cannot use PostgreSQL (${reason}). Start it with: bash scripts/db-up.sh`,
      );
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  poolStats(): { total: number; idle: number; waiting: number } {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }

  async migrate(): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      return await runMigrations(client, MIGRATIONS, (message) =>
        this.logger.log(message),
      );
    } finally {
      client.release();
    }
  }

  rows<R = Record<string, any>>(
    text: string,
    values?: unknown[],
  ): Promise<R[]> {
    return this.executor.rows<R>(text, values);
  }

  row<R = Record<string, any>>(
    text: string,
    values?: unknown[],
  ): Promise<R | undefined> {
    return this.executor.row<R>(text, values);
  }

  run(text: string, values?: unknown[]): Promise<number> {
    return this.executor.run(text, values);
  }

  async tx<T>(work: (db: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(new Executor(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        this.logger.warn('Rollback failed');
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
