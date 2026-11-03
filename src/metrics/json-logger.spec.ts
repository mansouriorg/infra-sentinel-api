import { JsonLogger } from './json-logger';

function setup() {
  const lines: string[] = [];
  const logger = new JsonLogger(
    (line) => lines.push(line),
    () => new Date('2026-01-02T03:04:05.000Z'),
  );
  return {
    lines,
    logger,
    last: () => JSON.parse(lines[lines.length - 1]) as Record<string, unknown>,
  };
}

describe('JsonLogger', () => {
  it('writes one JSON object per line with level, time and context', () => {
    const { logger, lines, last } = setup();

    logger.log('Started', 'Bootstrap');

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(last()).toEqual({
      time: '2026-01-02T03:04:05.000Z',
      level: 'info',
      context: 'Bootstrap',
      message: 'Started',
    });
  });

  it('maps every Nest level', () => {
    const { logger, last } = setup();
    const seen: unknown[] = [];
    logger.warn('a');
    seen.push(last().level);
    logger.debug('b');
    seen.push(last().level);
    logger.verbose('c');
    seen.push(last().level);
    logger.fatal('d');
    seen.push(last().level);
    logger.error('e');
    seen.push(last().level);

    expect(seen).toEqual(['warn', 'debug', 'trace', 'fatal', 'error']);
  });

  it('keeps stack traces on errors', () => {
    const { logger, last } = setup();

    logger.error('Request failed', 'Error: boom\n    at somewhere', 'Http');
    expect(last().stack).toBe('Error: boom\n    at somewhere');
    expect(last().context).toBe('Http');

    logger.error(new Error('direct'));
    expect(last().message).toBe('direct');
    expect(typeof last().stack).toBe('string');
  });

  it('serializes objects and survives circular values', () => {
    const { logger, last } = setup();
    logger.log({ a: 1 });
    expect(last().message).toBe('{"a":1}');

    const loop: Record<string, unknown> = {};
    loop.self = loop;
    logger.log(loop);
    expect(typeof last().message).toBe('string');
  });

  it('escapes newlines inside messages', () => {
    const { logger, lines, last } = setup();
    logger.log('first\nsecond');

    expect(lines[0]).not.toContain('\n');
    expect(last().message).toBe('first\nsecond');
  });
});
