import {
  assertLimits,
  createSchema,
  describeTarget,
  maskConfig,
  MASK,
  parseConfig,
  parseWith,
  restoreMasked,
  updateSchema,
} from './monitor.schema';

describe('createSchema', () => {
  it('fills in defaults for an HTTP monitor', () => {
    const input = parseWith(createSchema, {
      type: 'http',
      name: '  Website  ',
      config: { url: 'https://example.com' },
    });

    expect(input.name).toBe('Website');
    expect(input.intervalSec).toBe(60);
    expect(input.timeoutMs).toBe(10_000);
    expect(input.failureThreshold).toBe(2);
    expect(input.tags).toEqual([]);
    expect(input.config).toMatchObject({
      method: 'GET',
      expectedStatus: '200-299',
      followRedirects: true,
      ignoreTls: false,
      headers: {},
    });
  });

  it('accepts every monitor type with a minimal config', () => {
    const samples = [
      {
        type: 'keyword',
        config: { url: 'https://example.com', keyword: 'ok' },
      },
      { type: 'tcp', config: { host: 'db.internal', port: 5432 } },
      { type: 'ping', config: { host: '1.1.1.1' } },
      { type: 'dns', config: { host: 'example.com' } },
      { type: 'ssl', config: { host: 'example.com' }, intervalSec: 3600 },
      { type: 'heartbeat', config: {}, intervalSec: 300 },
    ];
    for (const sample of samples) {
      expect(() =>
        parseWith(createSchema, { name: 'x', ...sample }),
      ).not.toThrow();
    }
  });

  it('normalizes tags', () => {
    const input = parseWith(createSchema, {
      type: 'ping',
      name: 'Router',
      tags: ['Prod', ' Network '],
      config: { host: '10.0.0.1' },
    });
    expect(input.tags).toEqual(['prod', 'network']);
  });

  it('rejects bad input with readable messages', () => {
    expect(() =>
      parseWith(createSchema, {
        type: 'http',
        name: 'x',
        config: { url: 'ftp://example.com' },
      }),
    ).toThrow(/http/);
    expect(() =>
      parseWith(createSchema, {
        type: 'http',
        name: '',
        config: { url: 'https://a.com' },
      }),
    ).toThrow(/name/);
    expect(() =>
      parseWith(createSchema, {
        type: 'tcp',
        name: 'x',
        config: { host: 'db', port: 70000 },
      }),
    ).toThrow(/port/);
    expect(() =>
      parseWith(createSchema, { type: 'nope', name: 'x', config: {} }),
    ).toThrow();
    expect(() =>
      parseWith(createSchema, {
        type: 'ping',
        name: 'x',
        config: { host: '-c 100 evil' },
      }),
    ).toThrow(/host/);
    expect(() =>
      parseWith(createSchema, {
        type: 'ping',
        name: 'x',
        config: { host: '--help' },
      }),
    ).toThrow(/host/);
  });

  it('rejects intervals below the minimum', () => {
    expect(() =>
      parseWith(createSchema, {
        type: 'ping',
        name: 'x',
        intervalSec: 5,
        config: { host: 'a.com' },
      }),
    ).toThrow(/intervalSec/);
  });

  it('rejects header injection', () => {
    expect(() =>
      parseWith(createSchema, {
        type: 'http',
        name: 'x',
        config: {
          url: 'https://a.com',
          headers: { 'X-Test': 'a\r\nInjected: 1' },
        },
      }),
    ).toThrow();
  });
});

describe('updateSchema', () => {
  it('allows partial updates and rejects unknown fields', () => {
    expect(parseWith(updateSchema, { name: 'New name', tags: ['a'] })).toEqual({
      name: 'New name',
      tags: ['a'],
    });
    expect(() => parseWith(updateSchema, { type: 'tcp' })).toThrow();
    expect(() => parseWith(updateSchema, { intervalSec: 1 })).toThrow();
  });
});

describe('parseConfig', () => {
  it('validates a merged config for a given type', () => {
    expect(parseConfig('tcp', { host: 'db', port: '5432' })).toMatchObject({
      host: 'db',
      port: 5432,
    });
    expect(() => parseConfig('tcp', { host: 'db' })).toThrow(/port/);
  });

  it('treats empty optional numbers as unset', () => {
    const config = parseConfig('http', {
      url: 'https://a.com',
      degradedMs: '',
    });
    expect(config.degradedMs).toBeUndefined();
  });
});

describe('assertLimits', () => {
  it('enforces per-type rules', () => {
    expect(() => assertLimits('http', 60, 10_000)).not.toThrow();
    expect(() => assertLimits('http', 20, 30_000)).toThrow(/timeout/);
    expect(() => assertLimits('ssl', 60, 5000)).toThrow(/5 minutes/);
    expect(() => assertLimits('heartbeat', 20, 5000)).toThrow(/30 seconds/);
    expect(() => assertLimits('heartbeat', 60, 60_000)).not.toThrow();
  });
});

describe('header masking', () => {
  const config = {
    url: 'https://a.com',
    headers: { Authorization: 'Bearer secret', 'X-Env': 'prod' },
  };

  it('never exposes header values', () => {
    expect(maskConfig(config).headers).toEqual({
      Authorization: MASK,
      'X-Env': MASK,
    });
  });

  it('keeps stored values when the masked placeholder is sent back', () => {
    const incoming = {
      url: 'https://a.com',
      headers: { Authorization: MASK, 'X-Env': 'staging', 'X-New': 'n' },
    };
    expect(restoreMasked(incoming, config).headers).toEqual({
      Authorization: 'Bearer secret',
      'X-Env': 'staging',
      'X-New': 'n',
    });
  });
});

describe('stored header values and the address they belong to', () => {
  const stored = {
    url: 'https://a.com/health',
    headers: { Authorization: 'Bearer secret' },
  };
  const ask = (
    url: string,
    headers: Record<string, string> = { Authorization: MASK },
  ) => restoreMasked({ url, headers }, stored);

  it('refuses to hand stored values to another address', () => {
    expect(() => ask('https://attacker.test/x')).toThrow(/Re-enter/);
    expect(() => ask('http://a.com/health')).toThrow(/Re-enter/);
    expect(() => ask('https://a.com:8443/health')).toThrow(/Re-enter/);
    expect(() => ask('https://a.com.attacker.test/health')).toThrow(/Re-enter/);
    expect(() => ask('not a url')).toThrow(/Re-enter/);
  });

  it('allows another path on the same site and any address when no stored value is requested', () => {
    expect(ask('https://a.com/other/path?x=1').headers).toEqual({
      Authorization: 'Bearer secret',
    });
    expect(
      ask('https://attacker.test/x', { Authorization: 'Bearer mine' }).headers,
    ).toEqual({ Authorization: 'Bearer mine' });
    expect(restoreMasked({ url: 'https://attacker.test/x' }, stored)).toEqual({
      url: 'https://attacker.test/x',
    });
  });
});

describe('describeTarget', () => {
  it('summarizes each type', () => {
    expect(describeTarget('http', { url: 'https://a.com' }, 60)).toBe(
      'https://a.com',
    );
    expect(describeTarget('tcp', { host: 'db', port: 5432 }, 60)).toBe(
      'db:5432',
    );
    expect(describeTarget('dns', { host: 'a.com', recordType: 'MX' }, 60)).toBe(
      'a.com (MX record)',
    );
    expect(describeTarget('ssl', { host: 'a.com' }, 3600)).toBe('a.com:443');
    expect(describeTarget('heartbeat', {}, 300)).toBe(
      'Expects a ping every 5m',
    );
  });
});
