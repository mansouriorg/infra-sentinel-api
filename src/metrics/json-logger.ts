import type { LoggerService } from '@nestjs/common';

type Level = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export class JsonLogger implements LoggerService {
  constructor(
    private readonly write: (line: string) => void = (line) => {
      process.stdout.write(`${line}\n`);
    },
    private readonly now: () => Date = () => new Date(),
  ) {}

  log(message: unknown, ...rest: unknown[]): void {
    this.emit('info', message, rest);
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.emit('error', message, rest);
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.emit('warn', message, rest);
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.emit('debug', message, rest);
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.emit('trace', message, rest);
  }

  fatal(message: unknown, ...rest: unknown[]): void {
    this.emit('fatal', message, rest);
  }

  private emit(level: Level, message: unknown, rest: unknown[]): void {
    const params = [...rest];
    let context: string | undefined;
    if (params.length > 0 && typeof params[params.length - 1] === 'string') {
      context = params.pop() as string;
    }
    let stack: string | undefined;
    if (message instanceof Error && message.stack) stack = message.stack;
    if (
      stack === undefined &&
      (level === 'error' || level === 'fatal') &&
      typeof params[0] === 'string'
    ) {
      stack = params[0];
    }
    const entry: Record<string, unknown> = {
      time: this.now().toISOString(),
      level,
      ...(context ? { context } : {}),
      message: text(message),
      ...(stack ? { stack } : {}),
    };
    this.write(JSON.stringify(entry));
  }
}
