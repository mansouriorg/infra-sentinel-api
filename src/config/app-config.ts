import type { Env } from './env';

export class AppConfig {
  constructor(readonly env: Env) {}

  get<K extends keyof Env>(key: K): Env[K] {
    return this.env[key];
  }
}
