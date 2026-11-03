import {
  enrollSchema,
  linkMonitorsSchema,
  parseWith,
  reportSchema,
  serverPatchSchema,
  serverRulePatchSchema,
  serverRuleSchema,
  tokenCreateSchema,
} from './server.schema';

const channel = '11111111-1111-4111-8111-111111111111';
const server = '22222222-2222-4222-8222-222222222222';

const rule = (patch: Record<string, unknown> = {}) => ({
  name: 'High CPU',
  metric: 'cpu',
  scope: { all: true },
  channelIds: [channel],
  ...patch,
});

describe('enroll and report payloads', () => {
  it('accepts an enrollment request with missing optional info', () => {
    const parsed = parseWith(enrollSchema, {
      token: 'ist_abcdefgh',
      info: { hostname: 'web-1' },
    });
    expect(parsed.info.hostname).toBe('web-1');
    expect(parsed.info.cpuCount).toBe(0);
    expect(parsed.info.docker).toBe(false);
    expect(() => parseWith(enrollSchema, { token: 'x', info: {} })).toThrow();
    expect(() => parseWith(enrollSchema, { info: {} })).toThrow();
  });

  it('accepts a report and fills in defaults', () => {
    const parsed = parseWith(reportSchema, {
      samples: [{ at: 1700000000, cpu: 12.5, mem: 40 }],
      snapshot: { disks: [{ mount: '/', pct: 20 }], failedServices: ['a'] },
    });
    expect(parsed.samples[0]).toMatchObject({
      at: 1700000000,
      cpu: 12.5,
      netIn: 0,
      load1: 0,
    });
    expect(parsed.snapshot.disks?.[0].fs).toBe('');
    expect(parseWith(reportSchema, {}).samples).toEqual([]);
    expect(parseWith(reportSchema, undefined).snapshot).toEqual({});
  });

  it('rejects oversized or malformed reports', () => {
    const many = Array.from({ length: 121 }, (_, index) => ({
      at: 1700000000 + index,
    }));
    expect(() => parseWith(reportSchema, { samples: many })).toThrow();
    expect(() =>
      parseWith(reportSchema, { samples: [{ at: 'now' }] }),
    ).toThrow();
    expect(() =>
      parseWith(reportSchema, {
        samples: [{ at: 1, cpu: Number.POSITIVE_INFINITY }],
      }),
    ).toThrow();
    expect(() =>
      parseWith(reportSchema, { snapshot: { containers: [{ id: 'a' }] } }),
    ).toThrow();
    const containers = Array.from({ length: 151 }, (_, index) => ({
      id: String(index),
      name: `c${index}`,
    }));
    expect(() =>
      parseWith(reportSchema, { snapshot: { containers } }),
    ).toThrow();
  });
});

describe('small payloads', () => {
  it('validates server edits', () => {
    expect(
      parseWith(serverPatchSchema, { name: ' web ', tags: ['Prod', 'eu-1'] }),
    ).toEqual({ name: 'web', tags: ['prod', 'eu-1'] });
    expect(() => parseWith(serverPatchSchema, { name: '' })).toThrow();
    expect(() => parseWith(serverPatchSchema, { tags: ['bad tag'] })).toThrow();
    expect(() => parseWith(serverPatchSchema, { other: 1 })).toThrow();
  });

  it('validates tokens and monitor links', () => {
    expect(parseWith(tokenCreateSchema, { name: 'Prod' })).toMatchObject({
      name: 'Prod',
      expiresInDays: 7,
    });
    expect(
      parseWith(tokenCreateSchema, {
        name: 'Prod',
        expiresInDays: 30,
        maxUses: '5',
      }),
    ).toMatchObject({ expiresInDays: 30, maxUses: 5 });
    expect(() =>
      parseWith(tokenCreateSchema, { name: 'Prod', expiresInDays: 0 }),
    ).toThrow();
    expect(() =>
      parseWith(tokenCreateSchema, { name: 'Prod', maxUses: 0 }),
    ).toThrow();
    expect(
      parseWith(linkMonitorsSchema, { monitorIds: [server, server] }),
    ).toEqual({ monitorIds: [server] });
    expect(() =>
      parseWith(linkMonitorsSchema, { monitorIds: ['nope'] }),
    ).toThrow();
  });
});

describe('server rules', () => {
  it('fills in defaults for a threshold rule', () => {
    expect(parseWith(serverRuleSchema, rule())).toMatchObject({
      metric: 'cpu',
      mode: 'threshold',
      threshold: 90,
      forSec: 300,
      severity: 'warning',
      target: '',
      scope: { all: true, serverIds: [], tags: [] },
      notifyRecovery: true,
    });
    expect(
      parseWith(serverRuleSchema, rule({ metric: 'offline' })).threshold,
    ).toBe(90);
    expect(
      parseWith(serverRuleSchema, rule({ metric: 'load' })).threshold,
    ).toBe(2);
    expect(
      parseWith(serverRuleSchema, rule({ metric: 'disk', threshold: '85' }))
        .threshold,
    ).toBe(85);
  });

  it('checks the threshold range for each metric', () => {
    expect(() => parseWith(serverRuleSchema, rule({ threshold: 0 }))).toThrow();
    expect(() =>
      parseWith(serverRuleSchema, rule({ threshold: 101 })),
    ).toThrow();
    expect(() =>
      parseWith(serverRuleSchema, rule({ metric: 'load', threshold: 0.01 })),
    ).toThrow();
    expect(() =>
      parseWith(serverRuleSchema, rule({ metric: 'offline', threshold: 5 })),
    ).toThrow();
    expect(
      parseWith(serverRuleSchema, rule({ metric: 'offline', threshold: 30 }))
        .threshold,
    ).toBe(30);
  });

  it('needs a name for container, service and process rules', () => {
    expect(() =>
      parseWith(serverRuleSchema, rule({ metric: 'container' })),
    ).toThrow();
    expect(
      parseWith(
        serverRuleSchema,
        rule({ metric: 'container', target: 'api-*', threshold: 50 }),
      ),
    ).toMatchObject({ target: 'api-*', threshold: null });
    expect(
      parseWith(serverRuleSchema, rule({ metric: 'service', target: '*' }))
        .target,
    ).toBe('*');
    expect(() =>
      parseWith(
        serverRuleSchema,
        rule({ metric: 'service', target: 'bad name' }),
      ),
    ).toThrow();
    expect(() =>
      parseWith(serverRuleSchema, rule({ metric: 'process', target: '$(x)' })),
    ).toThrow();
    expect(
      parseWith(
        serverRuleSchema,
        rule({ metric: 'process', target: 'redis-server' }),
      ).target,
    ).toBe('redis-server');
  });

  it('limits anomaly detection to some metrics and clears threshold fields', () => {
    expect(
      parseWith(
        serverRuleSchema,
        rule({ mode: 'anomaly', metric: 'cpu', threshold: 50, target: 'x' }),
      ),
    ).toMatchObject({
      mode: 'anomaly',
      threshold: null,
      target: '',
    });
    expect(
      parseWith(serverRuleSchema, rule({ mode: 'anomaly', metric: 'net_in' }))
        .metric,
    ).toBe('net_in');
    expect(() =>
      parseWith(serverRuleSchema, rule({ mode: 'anomaly', metric: 'disk' })),
    ).toThrow();
    expect(() =>
      parseWith(serverRuleSchema, rule({ metric: 'net_out' })),
    ).toThrow();
  });

  it('needs a place to send alerts and a scope', () => {
    expect(() =>
      parseWith(serverRuleSchema, rule({ channelIds: [] })),
    ).toThrow();
    expect(
      parseWith(serverRuleSchema, rule({ channelIds: [], policyId: channel }))
        .policyId,
    ).toBe(channel);
    expect(() =>
      parseWith(serverRuleSchema, rule({ scope: { all: false } })),
    ).toThrow();
    expect(
      parseWith(
        serverRuleSchema,
        rule({ scope: { all: false, serverIds: [server] } }),
      ).scope.serverIds,
    ).toEqual([server]);
    expect(
      parseWith(
        serverRuleSchema,
        rule({ scope: { all: true, serverIds: [server], tags: ['x'] } }),
      ).scope,
    ).toEqual({
      all: true,
      serverIds: [],
      tags: [],
    });
    expect(() => parseWith(serverRuleSchema, rule({ unknown: 1 }))).toThrow();
    expect(
      parseWith(serverRuleSchema, rule({ channelIds: [channel, channel] }))
        .channelIds,
    ).toEqual([channel]);
  });

  it('accepts partial updates', () => {
    expect(
      parseWith(serverRulePatchSchema, { enabled: false, forSec: '60' }),
    ).toEqual({ enabled: false, forSec: 60 });
    expect(() =>
      parseWith(serverRulePatchSchema, { metric: 'nope' }),
    ).toThrow();
    expect(() => parseWith(serverRulePatchSchema, { other: true })).toThrow();
  });
});
