import {
  breachKey,
  evaluateRule,
  formatBytes,
  formatRate,
  globMatch,
  MIN_BASELINE_SAMPLES,
  ruleTitle,
  type RuleFacts,
  type ServerFacts,
} from './server.rules';
import type { Baselines } from './server.types';

const rule = (patch: Partial<RuleFacts>): RuleFacts => ({
  metric: 'cpu',
  mode: 'threshold',
  threshold: 90,
  sensitivity: 'medium',
  target: '',
  ...patch,
});

const server = (patch: Partial<ServerFacts> = {}): ServerFacts => ({
  status: 'online',
  ageSec: 5,
  cpuCount: 4,
  docker: true,
  systemd: true,
  latest: { cpu: 50, mem: 40, swap: 0, load1: 2, disk: 50 },
  snapshot: {},
  ...patch,
});

describe('evaluateRule thresholds', () => {
  it('breaches CPU, memory and swap above the limit only', () => {
    const high = server({ latest: { cpu: 95.5, mem: 91, swap: 85 } });
    expect(evaluateRule(rule({}), high)).toEqual({
      known: true,
      breaches: [
        {
          subject: '',
          value: 95.5,
          detail: 'CPU is at 95.5%, the limit is 90%',
        },
      ],
    });
    expect(evaluateRule(rule({ metric: 'memory' }), high)).toMatchObject({
      known: true,
      breaches: [{ value: 91 }],
    });
    expect(
      evaluateRule(rule({ metric: 'swap', threshold: 80 }), high),
    ).toMatchObject({ known: true, breaches: [{ value: 85 }] });
    expect(evaluateRule(rule({}), server())).toEqual({
      known: true,
      breaches: [],
    });
    expect(evaluateRule(rule({ threshold: 50 }), server())).toEqual({
      known: true,
      breaches: [],
    });
  });

  it('divides the load by the number of cores', () => {
    const busy = server({ latest: { load1: 12 }, cpuCount: 4 });
    expect(
      evaluateRule(rule({ metric: 'load', threshold: 2 }), busy),
    ).toMatchObject({
      known: true,
      breaches: [{ value: 3, detail: 'Load is 3 per core, the limit is 2' }],
    });
    expect(evaluateRule(rule({ metric: 'load', threshold: 4 }), busy)).toEqual({
      known: true,
      breaches: [],
    });
    expect(
      evaluateRule(
        rule({ metric: 'load', threshold: 1 }),
        server({ latest: { load1: 2 }, cpuCount: 0 }),
      ),
    ).toMatchObject({
      known: true,
      breaches: [{ value: 2 }],
    });
  });

  it('reports one breach per full disk', () => {
    const disks = server({
      snapshot: {
        disks: [
          { mount: '/', device: 'a', fs: 'ext4', total: 1, used: 1, pct: 93.2 },
          {
            mount: '/data',
            device: 'b',
            fs: 'ext4',
            total: 1,
            used: 1,
            pct: 40,
          },
          {
            mount: '/backup',
            device: 'c',
            fs: 'ext4',
            total: 1,
            used: 1,
            pct: 99,
          },
        ],
      },
    });
    const result = evaluateRule(rule({ metric: 'disk' }), disks);
    expect(result).toMatchObject({ known: true });
    if (result.known)
      expect(result.breaches.map((b) => b.subject)).toEqual(['/', '/backup']);
  });

  it('does not know a value that the agent has not sent yet', () => {
    expect(evaluateRule(rule({}), server({ latest: {} }))).toEqual({
      known: false,
    });
    expect(
      evaluateRule(rule({ metric: 'load' }), server({ latest: {} })),
    ).toEqual({ known: false });
  });

  it('only the offline rule can fire for a server that stopped reporting', () => {
    const stale = server({ status: 'offline', ageSec: 400 });
    expect(evaluateRule(rule({}), stale)).toEqual({ known: false });
    expect(
      evaluateRule(rule({ metric: 'offline', threshold: 120 }), stale),
    ).toMatchObject({
      known: true,
      breaches: [{ subject: '', value: 400, detail: 'No data for 6m' }],
    });
    expect(
      evaluateRule(rule({ metric: 'offline', threshold: 600 }), stale),
    ).toEqual({ known: true, breaches: [] });
    expect(
      evaluateRule(
        rule({ metric: 'offline' }),
        server({ status: 'pending', ageSec: null }),
      ),
    ).toEqual({
      known: true,
      breaches: [],
    });
    expect(
      evaluateRule(
        rule({ metric: 'offline', threshold: null }),
        server({ ageSec: 100 }),
      ),
    ).toMatchObject({ known: true });
  });
});

describe('evaluateRule names', () => {
  const containers = [
    {
      id: '1',
      name: 'api-1',
      image: 'x',
      state: 'running',
      health: 'healthy',
      status: '',
      createdAt: 0,
      cpu: null,
      memUsed: null,
      memLimit: null,
      netIn: null,
      netOut: null,
    },
    {
      id: '2',
      name: 'api-2',
      image: 'x',
      state: 'exited',
      health: '',
      status: '',
      createdAt: 0,
      cpu: null,
      memUsed: null,
      memLimit: null,
      netIn: null,
      netOut: null,
    },
    {
      id: '3',
      name: 'db',
      image: 'x',
      state: 'running',
      health: 'unhealthy',
      status: '',
      createdAt: 0,
      cpu: null,
      memUsed: null,
      memLimit: null,
      netIn: null,
      netOut: null,
    },
  ];

  it('matches containers with wildcards and flags states', () => {
    const facts = server({ snapshot: { containers } });
    const result = evaluateRule(
      rule({ metric: 'container', threshold: null, target: 'api-*' }),
      facts,
    );
    expect(result).toMatchObject({
      known: true,
      breaches: [{ subject: 'api-2', detail: 'Container api-2 is exited' }],
    });
    const unhealthy = evaluateRule(
      rule({ metric: 'container', threshold: null, target: 'db' }),
      facts,
    );
    expect(unhealthy).toMatchObject({
      known: true,
      breaches: [{ subject: 'db', detail: 'Container db is unhealthy' }],
    });
    expect(
      evaluateRule(
        rule({ metric: 'container', threshold: null, target: 'zzz-*' }),
        facts,
      ),
    ).toEqual({ known: true, breaches: [] });
  });

  it('flags a missing container with an exact name', () => {
    const facts = server({ snapshot: { containers } });
    expect(
      evaluateRule(
        rule({ metric: 'container', threshold: null, target: 'cache' }),
        facts,
      ),
    ).toMatchObject({
      known: true,
      breaches: [{ subject: 'cache', detail: 'Container cache was not found' }],
    });
  });

  it('does not know containers without Docker data', () => {
    expect(
      evaluateRule(
        rule({ metric: 'container', target: 'db' }),
        server({ snapshot: {} }),
      ),
    ).toEqual({ known: false });
    expect(
      evaluateRule(
        rule({ metric: 'container', target: 'db' }),
        server({ docker: false, snapshot: { containers } }),
      ),
    ).toEqual({
      known: false,
    });
  });

  it('checks systemd services', () => {
    const facts = server({
      snapshot: {
        services: [
          { name: 'nginx', state: 'active' },
          { name: 'redis', state: 'failed' },
          { name: 'ghost', state: 'unknown' },
        ],
        failedServices: ['redis', 'cron'],
      },
    });
    expect(
      evaluateRule(rule({ metric: 'service', target: 'nginx' }), facts),
    ).toEqual({ known: true, breaches: [] });
    expect(
      evaluateRule(rule({ metric: 'service', target: 'redis.service' }), facts),
    ).toMatchObject({
      known: true,
      breaches: [
        { subject: 'redis.service', detail: 'Service redis.service is failed' },
      ],
    });
    expect(
      evaluateRule(rule({ metric: 'service', target: 'missing' }), facts),
    ).toEqual({ known: false });
    expect(
      evaluateRule(rule({ metric: 'service', target: 'ghost' }), facts),
    ).toEqual({ known: false });
    const any = evaluateRule(rule({ metric: 'service', target: '*' }), facts);
    expect(any).toMatchObject({ known: true });
    if (any.known)
      expect(any.breaches.map((b) => b.subject)).toEqual(['redis', 'cron']);
    expect(
      evaluateRule(
        rule({ metric: 'service', target: 'nginx' }),
        server({ systemd: false, snapshot: facts.snapshot }),
      ),
    ).toEqual({
      known: false,
    });
  });

  it('checks watched processes', () => {
    const facts = server({
      snapshot: { watchedProcesses: { redis: 0, nginx: 3 } },
    });
    expect(
      evaluateRule(rule({ metric: 'process', target: 'nginx' }), facts),
    ).toEqual({ known: true, breaches: [] });
    expect(
      evaluateRule(rule({ metric: 'process', target: 'redis' }), facts),
    ).toMatchObject({
      known: true,
      breaches: [{ subject: 'redis', detail: 'Process redis is not running' }],
    });
    expect(
      evaluateRule(rule({ metric: 'process', target: 'other' }), facts),
    ).toEqual({ known: false });
  });
});

describe('evaluateRule anomalies', () => {
  const baselines = (patch: Partial<Baselines['cpu']> = {}): Baselines => ({
    cpu: {
      recent: 80,
      mean: 20,
      std: 5,
      samples: 1000,
      recentSamples: 20,
      ...patch,
    },
  });
  const anomalyRule = rule({ mode: 'anomaly', threshold: null });

  it('flags a value far above the usual', () => {
    const result = evaluateRule(anomalyRule, server(), baselines());
    expect(result).toMatchObject({
      known: true,
      breaches: [{ value: 80, detail: 'CPU usage is 80%, usually about 20%' }],
    });
  });

  it('stays quiet for normal variation or a small absolute change', () => {
    expect(
      evaluateRule(anomalyRule, server(), baselines({ recent: 28 })),
    ).toEqual({ known: true, breaches: [] });
    expect(
      evaluateRule(
        anomalyRule,
        server(),
        baselines({ mean: 2, std: 0.1, recent: 12 }),
      ),
    ).toEqual({ known: true, breaches: [] });
  });

  it('needs enough history', () => {
    expect(
      evaluateRule(
        anomalyRule,
        server(),
        baselines({ samples: MIN_BASELINE_SAMPLES - 1 }),
      ),
    ).toEqual({ known: false });
    expect(
      evaluateRule(anomalyRule, server(), baselines({ recentSamples: 1 })),
    ).toEqual({ known: false });
    expect(
      evaluateRule(anomalyRule, server(), baselines({ mean: null })),
    ).toEqual({ known: false });
    expect(evaluateRule(anomalyRule, server(), undefined)).toEqual({
      known: false,
    });
  });

  it('sensitivity changes how many standard deviations count', () => {
    const edge = baselines({ mean: 20, std: 10, recent: 45 });
    expect(
      evaluateRule(
        rule({ mode: 'anomaly', sensitivity: 'high' }),
        server(),
        edge,
      ),
    ).toMatchObject({ known: true, breaches: [{}] });
    expect(
      evaluateRule(
        rule({ mode: 'anomaly', sensitivity: 'low' }),
        server(),
        edge,
      ),
    ).toEqual({ known: true, breaches: [] });
  });

  it('judges load per core and network by rate', () => {
    const loadRule = rule({ metric: 'load', mode: 'anomaly', threshold: null });
    const load = evaluateRule(loadRule, server({ cpuCount: 4 }), {
      load: { recent: 12, mean: 2, std: 0.4, samples: 500, recentSamples: 10 },
    });
    expect(load).toMatchObject({
      known: true,
      breaches: [
        { value: 3, detail: 'Load is 3 per core, usually about 0.5 per core' },
      ],
    });

    const netRule = rule({
      metric: 'net_in',
      mode: 'anomaly',
      threshold: null,
    });
    const net = evaluateRule(netRule, server(), {
      net_in: {
        recent: 30 * 1024 * 1024,
        mean: 1024 * 1024,
        std: 200_000,
        samples: 500,
        recentSamples: 10,
      },
    });
    expect(net).toMatchObject({
      known: true,
      breaches: [
        { detail: 'Inbound traffic is 30.0 MB/s, usually about 1.00 MB/s' },
      ],
    });
    const calm = evaluateRule(netRule, server(), {
      net_in: {
        recent: 1.5 * 1024 * 1024,
        mean: 1024 * 1024,
        std: 100_000,
        samples: 500,
        recentSamples: 10,
      },
    });
    expect(calm).toEqual({ known: true, breaches: [] });
  });
});

describe('helpers', () => {
  it('matches globs literally', () => {
    expect(globMatch('api-*', 'api-1')).toBe(true);
    expect(globMatch('api-*', 'web-api-1')).toBe(false);
    expect(globMatch('*', 'anything')).toBe(true);
    expect(globMatch('a.b', 'axb')).toBe(false);
    expect(globMatch('a.*', 'a.b')).toBe(true);
    expect(globMatch('db', 'db')).toBe(true);
  });

  it('agrees with a plain regular expression on small inputs', () => {
    const reference = (pattern: string, value: string) => {
      const escaped = pattern
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
      return new RegExp(`^${escaped.join('.*')}$`).test(value);
    };
    const alphabet = ['a', 'b', '*'];
    const words: string[] = [''];
    for (let length = 1; length <= 5; length += 1) {
      const next: string[] = [];
      for (const word of words.filter((entry) => entry.length === length - 1)) {
        for (const letter of alphabet) next.push(word + letter);
      }
      words.push(...next);
    }
    const values = words.filter((word) => !word.includes('*'));
    for (const pattern of words.filter((word) => word.includes('*'))) {
      for (const value of values) {
        expect(globMatch(pattern, value)).toBe(reference(pattern, value));
      }
    }
  });

  it('stays fast on patterns that make regular expressions backtrack', () => {
    const started = Date.now();
    expect(globMatch('a*a*a*a*a*a*a*a*b', 'a'.repeat(200))).toBe(false);
    expect(globMatch('*'.repeat(50) + 'b', 'a'.repeat(200))).toBe(false);
    expect(globMatch('a*'.repeat(49) + 'a', 'a'.repeat(200))).toBe(true);
    expect(globMatch('*a*b*c*', `${'a'.repeat(100)}${'b'.repeat(50)}c`)).toBe(
      true,
    );
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('formats sizes and rates', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.50 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.00 MB');
    expect(formatBytes(250 * 1024 * 1024 * 1024)).toBe('250 GB');
    expect(formatRate(2048)).toBe('2.00 KB/s');
  });

  it('writes readable titles', () => {
    expect(ruleTitle(rule({ metric: 'offline' }), 'web-1', '')).toBe(
      'web-1 is offline',
    );
    expect(ruleTitle(rule({ metric: 'cpu', threshold: 90 }), 'web-1', '')).toBe(
      'web-1: CPU above 90%',
    );
    expect(
      ruleTitle(rule({ metric: 'disk', threshold: 85 }), 'web-1', '/data'),
    ).toBe('web-1: disk /data above 85%');
    expect(
      ruleTitle(rule({ metric: 'load', threshold: 1.5 }), 'web-1', ''),
    ).toBe('web-1: load above 1.5 per core');
    expect(
      ruleTitle(rule({ metric: 'container', threshold: null }), 'web-1', 'api'),
    ).toBe('web-1: container api is not healthy');
    expect(
      ruleTitle(rule({ metric: 'service', threshold: null }), 'web-1', 'nginx'),
    ).toBe('web-1: service nginx is not running');
    expect(
      ruleTitle(rule({ metric: 'process', threshold: null }), 'web-1', 'redis'),
    ).toBe('web-1: process redis is not running');
    expect(
      ruleTitle(
        rule({ metric: 'cpu', mode: 'anomaly', threshold: null }),
        'web-1',
        '',
      ),
    ).toBe('web-1: unusual CPU usage');
    expect(breachKey('r', 's', '/')).toBe('r|s|/');
  });
});
