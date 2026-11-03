import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { AppConfig } from '../../config/app-config';
import { validateEnv } from '../../config/env';
import { parseConfig } from '../monitor.schema';
import { checkDns, type DnsClient } from './dns.checker';
import {
  parsePingTime,
  pingArguments,
  resolvePingTarget,
} from './ping.checker';
import { CheckRunner } from './runner';

const runner = new CheckRunner(
  new AppConfig(validateEnv({ NODE_ENV: 'test' })),
);
const strictRunner = new CheckRunner(
  new AppConfig(
    validateEnv({ NODE_ENV: 'test', BLOCK_PRIVATE_TARGETS: 'true' }),
  ),
);

let server: http.Server;
let other: http.Server;
let base = '';
let otherBase = '';

function listen(handler: http.RequestListener): Promise<http.Server> {
  return new Promise((resolve) => {
    const created = http.createServer(handler);
    created.listen(0, '127.0.0.1', () => resolve(created));
  });
}

async function closedPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const httpConfig = (path: string, extra: Record<string, unknown> = {}) =>
  parseConfig('http', { url: `${base}${path}`, ...extra });

beforeAll(async () => {
  server = await listen((request, response) => {
    const url = request.url ?? '/';
    if (url === '/ok') {
      response.end('hello world');
    } else if (url === '/boom') {
      response.statusCode = 503;
      response.end('down');
    } else if (url === '/slow') {
      setTimeout(() => response.end('late'), 250);
    } else if (url === '/hang') {
      return;
    } else if (url === '/redirect') {
      response.statusCode = 302;
      response.setHeader('location', '/ok');
      response.end();
    } else if (url === '/to-same') {
      response.statusCode = 302;
      response.setHeader('location', '/header');
      response.end();
    } else if (url === '/to-other') {
      response.statusCode = 302;
      response.setHeader('location', `${otherBase}/header`);
      response.end();
    } else if (url === '/loop') {
      response.statusCode = 302;
      response.setHeader('location', '/loop');
      response.end();
    } else if (url === '/json') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: { status: 'ok', items: [1, 2] } }));
    } else if (url === '/header') {
      response.end(String(request.headers['x-token']));
    } else if (url === '/echo') {
      const parts: Buffer[] = [];
      request.on('data', (chunk: Buffer) => parts.push(chunk));
      request.on('end', () =>
        response.end(`${request.method}:${Buffer.concat(parts).toString()}`),
      );
    } else {
      response.statusCode = 404;
      response.end('nope');
    }
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  other = await listen((request, response) => {
    response.end(String(request.headers['x-token']));
  });
  otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  other.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => other.close(() => resolve()));
});

describe('http checks', () => {
  it('passes on a 200 and reports whole-millisecond timing', async () => {
    const result = await runner.run('http', httpConfig('/ok'), 5000);

    expect(result.status).toBe('up');
    expect(result.statusCode).toBe(200);
    expect(result.message).toBe('HTTP 200');
    expect(Number.isInteger(result.responseMs)).toBe(true);
    expect(result.responseMs as number).toBeGreaterThanOrEqual(1);
  });

  it('fails on an unexpected status code', async () => {
    const result = await runner.run('http', httpConfig('/boom'), 5000);

    expect(result.status).toBe('down');
    expect(result.statusCode).toBe(503);
    expect(result.message).toContain('HTTP 503');
  });

  it('accepts a custom expected status', async () => {
    const result = await runner.run(
      'http',
      httpConfig('/boom', { expectedStatus: '503' }),
      5000,
    );
    expect(result.status).toBe('up');
  });

  it('follows redirects by default and can stop following them', async () => {
    expect(
      (await runner.run('http', httpConfig('/redirect'), 5000)).status,
    ).toBe('up');

    const manual = await runner.run(
      'http',
      httpConfig('/redirect', { followRedirects: false }),
      5000,
    );
    expect(manual.status).toBe('down');
    expect(manual.statusCode).toBe(302);
  });

  it('gives up on redirect loops', async () => {
    const result = await runner.run('http', httpConfig('/loop'), 5000);
    expect(result.status).toBe('down');
    expect(result.message).toContain('Too many redirects');
  });

  it('checks for a keyword in either direction', async () => {
    const present = await runner.run(
      'keyword',
      parseConfig('keyword', { url: `${base}/ok`, keyword: 'HELLO' }),
      5000,
    );
    expect(present.status).toBe('up');
    expect(present.message).toContain('keyword found');

    const missing = await runner.run(
      'keyword',
      parseConfig('keyword', { url: `${base}/ok`, keyword: 'goodbye' }),
      5000,
    );
    expect(missing.status).toBe('down');
    expect(missing.message).toContain('not found');

    const strict = await runner.run(
      'keyword',
      parseConfig('keyword', {
        url: `${base}/ok`,
        keyword: 'HELLO',
        caseSensitive: true,
      }),
      5000,
    );
    expect(strict.status).toBe('down');

    const absent = await runner.run(
      'keyword',
      parseConfig('keyword', {
        url: `${base}/ok`,
        keyword: 'error',
        keywordMode: 'absent',
      }),
      5000,
    );
    expect(absent.status).toBe('up');
  });

  it('asserts on a JSON value', async () => {
    const good = await runner.run(
      'http',
      httpConfig('/json', { jsonPath: 'data.status', jsonEquals: 'ok' }),
      5000,
    );
    expect(good.status).toBe('up');

    const wrong = await runner.run(
      'http',
      httpConfig('/json', { jsonPath: 'data.status', jsonEquals: 'fail' }),
      5000,
    );
    expect(wrong.status).toBe('down');
    expect(wrong.message).toContain('expected "fail"');

    const notJson = await runner.run(
      'http',
      httpConfig('/ok', { jsonPath: 'a' }),
      5000,
    );
    expect(notJson.message).toContain('not valid JSON');

    const missing = await runner.run(
      'http',
      httpConfig('/json', { jsonPath: 'data.nope' }),
      5000,
    );
    expect(missing.status).toBe('down');
  });

  it('sends custom headers and request bodies', async () => {
    const header = await runner.run(
      'keyword',
      parseConfig('keyword', {
        url: `${base}/header`,
        headers: { 'X-Token': 'abc123' },
        keyword: 'abc123',
      }),
      5000,
    );
    expect(header.status).toBe('up');

    const post = await runner.run(
      'keyword',
      parseConfig('keyword', {
        url: `${base}/echo`,
        method: 'POST',
        body: 'ping',
        keyword: 'POST:ping',
      }),
      5000,
    );
    expect(post.status).toBe('up');
  });

  it('keeps custom headers on redirects within the same site and drops them when the site changes', async () => {
    const check = (path: string, keyword: string) =>
      runner.run(
        'keyword',
        parseConfig('keyword', {
          url: `${base}${path}`,
          headers: { 'X-Token': 'abc123' },
          keyword,
        }),
        5000,
      );

    expect((await check('/to-same', 'abc123')).status).toBe('up');
    expect((await check('/to-other', 'undefined')).status).toBe('up');
    expect((await check('/to-other', 'abc123')).status).toBe('down');
  });

  it('marks slow but successful checks as degraded', async () => {
    const result = await runner.run(
      'http',
      httpConfig('/slow', { degradedMs: 50 }),
      5000,
    );

    expect(result.status).toBe('degraded');
    expect(result.message).toContain('slow');
  });

  it('times out on a server that never answers', async () => {
    const result = await runner.run('http', httpConfig('/hang'), 1000);

    expect(result.status).toBe('down');
    expect(result.message).toBe('Timed out after 1000 ms');
    expect(result.responseMs).toBeNull();
  });

  it('reports a refused connection', async () => {
    const port = await closedPort();
    const result = await runner.run(
      'http',
      parseConfig('http', { url: `http://127.0.0.1:${port}/` }),
      3000,
    );

    expect(result.status).toBe('down');
    expect(result.message).toBe('Connection refused');
  });

  it('refuses local targets when the server blocks private addresses', async () => {
    const result = await strictRunner.run('http', httpConfig('/ok'), 3000);

    expect(result.status).toBe('down');
    expect(result.message).toContain('private or local');
  });
});

describe('tcp checks', () => {
  it('detects an open port', async () => {
    const port = Number(base.split(':').pop());
    const result = await runner.run(
      'tcp',
      parseConfig('tcp', { host: '127.0.0.1', port }),
      3000,
    );

    expect(result.status).toBe('up');
    expect(result.message).toBe(`Port ${port} is open`);
  });

  it('detects a closed port', async () => {
    const port = await closedPort();
    const result = await runner.run(
      'tcp',
      parseConfig('tcp', { host: '127.0.0.1', port }),
      3000,
    );

    expect(result.status).toBe('down');
    expect(result.message).toBe('Connection refused');
  });

  it('refuses local targets when blocking is on', async () => {
    const result = await strictRunner.run(
      'tcp',
      parseConfig('tcp', { host: '127.0.0.1', port: 80 }),
      3000,
    );
    expect(result.message).toContain('private or local');
  });

  it('refuses every spelling of a local IPv6 address when blocking is on', async () => {
    for (const host of [
      '0:0:0:0:0:0:0:1',
      '0:0:0:0:0:ffff:a9fe:a9fe',
      '::ffff:7f00:1',
      '64:ff9b::a9fe:a9fe',
    ]) {
      const tcp = await strictRunner.run(
        'tcp',
        parseConfig('tcp', { host, port: 80 }),
        3000,
      );
      expect(tcp.message).toContain('private or local');
      const ssl = await strictRunner.run(
        'ssl',
        parseConfig('ssl', { host }),
        3000,
      );
      expect(ssl.message).toContain('private or local');
    }
  });
});

describe('ping targets', () => {
  const lookup = (addresses: string[]) =>
    (async () =>
      addresses.map((address) => ({
        address,
        family: address.includes(':') ? 6 : 4,
      }))) as unknown as typeof import('node:dns').promises.lookup;

  it('leaves the host alone when blocking is off', async () => {
    expect(
      await resolvePingTarget('internal.example', false, lookup(['10.0.0.5'])),
    ).toBe('internal.example');
  });

  it('resolves names first and refuses any private answer when blocking is on', async () => {
    expect(
      await resolvePingTarget(
        'public.example',
        true,
        lookup(['93.184.216.34']),
      ),
    ).toBe('93.184.216.34');
    await expect(
      resolvePingTarget('internal.example', true, lookup(['10.0.0.5'])),
    ).rejects.toThrow(/private or local/);
    await expect(
      resolvePingTarget(
        'mixed.example',
        true,
        lookup(['93.184.216.34', '169.254.169.254']),
      ),
    ).rejects.toThrow(/private or local/);
    await expect(
      resolvePingTarget(
        'v6.example',
        true,
        lookup(['0:0:0:0:0:ffff:a9fe:a9fe']),
      ),
    ).rejects.toThrow(/private or local/);
    await expect(
      resolvePingTarget('127.0.0.1', true, lookup(['8.8.8.8'])),
    ).rejects.toThrow(/private or local/);
    expect(await resolvePingTarget('8.8.8.8', true, lookup(['10.0.0.5']))).toBe(
      '8.8.8.8',
    );
  });
});

describe('dns checks', () => {
  const context = { timeoutMs: 2000, blockPrivate: false };
  const answering = (answers: string[]): DnsClient => ({
    resolve: async () => answers,
  });

  it('passes when records exist', async () => {
    const config = parseConfig('dns', { host: 'example.test' }) as Parameters<
      typeof checkDns
    >[0];
    const result = await checkDns(
      config,
      context,
      answering(['93.184.216.34']),
    );

    expect(result.status).toBe('up');
    expect(result.message).toBe('A 93.184.216.34');
  });

  it('checks the expected value', async () => {
    const config = parseConfig('dns', {
      host: 'example.test',
      recordType: 'TXT',
      expected: 'v=spf1',
    }) as Parameters<typeof checkDns>[0];

    expect(
      (await checkDns(config, context, answering(['v=spf1 -all']))).status,
    ).toBe('up');
    expect(
      (await checkDns(config, context, answering(['something else']))).status,
    ).toBe('down');
  });

  it('refuses private resolvers when blocking is on and rejects resolvers with ports', async () => {
    const config = parseConfig('dns', {
      host: 'example.test',
      resolver: '10.0.0.2',
    }) as Parameters<typeof checkDns>[0];
    const blocked = await checkDns(
      config,
      { timeoutMs: 2000, blockPrivate: true },
      answering(['10.1.2.3']),
    );
    expect(blocked.status).toBe('down');
    expect(blocked.message).toContain('private or local');
    expect(
      (await checkDns(config, context, answering(['10.1.2.3']))).status,
    ).toBe('up');
    const mapped = parseConfig('dns', {
      host: 'example.test',
      resolver: '::ffff:a00:2',
    }) as Parameters<typeof checkDns>[0];
    expect(
      (
        await checkDns(
          mapped,
          { timeoutMs: 2000, blockPrivate: true },
          answering(['x']),
        )
      ).message,
    ).toContain('private or local');
    expect(() =>
      parseConfig('dns', { host: 'example.test', resolver: '10.0.0.2:5353' }),
    ).toThrow();
    expect(() =>
      parseConfig('dns', { host: 'example.test', resolver: 'ns.example.test' }),
    ).toThrow();
    expect(
      parseConfig('dns', { host: 'example.test', resolver: '1.1.1.1' }),
    ).toBeDefined();
  });

  it('turns lookup failures into readable messages', async () => {
    const config = parseConfig('dns', { host: 'missing.test' }) as Parameters<
      typeof checkDns
    >[0];
    const failing: DnsClient = {
      resolve: async () => {
        throw Object.assign(new Error('queryA ENODATA missing.test'), {
          code: 'ENODATA',
        });
      },
    };
    const result = await checkDns(config, context, failing);

    expect(result.status).toBe('down');
    expect(result.message).toBe('No A records found');
  });
});

describe('heartbeat and ping helpers', () => {
  it('reports a missed heartbeat as down', async () => {
    const result = await runner.run(
      'heartbeat',
      parseConfig('heartbeat', {}),
      1000,
    );
    expect(result.status).toBe('down');
    expect(result.message).toContain('No heartbeat');
  });

  it('builds ping arguments for each platform', () => {
    expect(pingArguments('linux', 'example.com', 5000)).toEqual([
      '-n',
      '-c',
      '1',
      '-W',
      '5',
      'example.com',
    ]);
    expect(pingArguments('darwin', 'example.com', 5000)).toEqual([
      '-n',
      '-c',
      '1',
      '-W',
      '5000',
      'example.com',
    ]);
    expect(pingArguments('win32', 'example.com', 5000)).toEqual([
      '-n',
      '1',
      '-w',
      '5000',
      'example.com',
    ]);
  });

  it('reads the round-trip time from ping output', () => {
    expect(
      parsePingTime('64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12.3 ms'),
    ).toBe(12.3);
    expect(parsePingTime('Reply from 1.1.1.1: bytes=32 time<1ms TTL=57')).toBe(
      1,
    );
    expect(parsePingTime('no reply')).toBeNull();
  });
});
