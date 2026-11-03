export interface Queryable {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface Db {
  rows<R = Record<string, any>>(text: string, values?: unknown[]): Promise<R[]>;
  row<R = Record<string, any>>(
    text: string,
    values?: unknown[],
  ): Promise<R | undefined>;
  run(text: string, values?: unknown[]): Promise<number>;
}

export class Executor implements Db {
  constructor(protected readonly target: Queryable) {}

  async rows<R = Record<string, any>>(
    text: string,
    values: unknown[] = [],
  ): Promise<R[]> {
    const result = await this.target.query(text, values);
    return result.rows as R[];
  }

  async row<R = Record<string, any>>(
    text: string,
    values: unknown[] = [],
  ): Promise<R | undefined> {
    const rows = await this.rows<R>(text, values);
    return rows[0];
  }

  async run(text: string, values: unknown[] = []): Promise<number> {
    const result = await this.target.query(text, values);
    return result.rowCount ?? 0;
  }
}
