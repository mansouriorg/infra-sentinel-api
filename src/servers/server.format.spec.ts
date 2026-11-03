import {
  containerSummary,
  offlineAfter,
  serverStatus,
  toRuleView,
  toSummary,
  toTokenView,
  tokenActive,
} from './server.format';
import type {
  EnrollmentTokenRow,
  ServerRow,
  ServerRuleRow,
} from './server.types';

const now = new Date('2026-01-01T12:00:00Z');
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);

const row = (patch: Partial<ServerRow> = {}): ServerRow => ({
  id: 's1',
  org_id: 'o1',
  name: 'web-1',
  hostname: 'web-1.local',
  tags: ['prod'],
  machine_id: 'm',
  agent_key_hash: 'h',
  agent_version: '0.5.0',
  os: 'linux',
  platform: 'Ubuntu 24.04',
  kernel: '6.8',
  arch: 'amd64',
  cpu_count: 4,
  mem_total: '8589934592',
  swap_total: '0',
  boot_time: ago(86_400),
  ip: '10.0.0.5',
  docker: true,
  systemd: true,
  interval_sec: 15,
  last_seen_at: ago(10),
  latest: { cpu: 12 },
  snapshot: {},
  created_at: ago(1000),
  updated_at: ago(10),
  ...patch,
});

describe('server status', () => {
  it('is pending, online or offline from the last report', () => {
    expect(serverStatus(null, 15, now)).toBe('pending');
    expect(serverStatus(ago(10), 15, now)).toBe('online');
    expect(serverStatus(ago(61), 15, now)).toBe('offline');
    expect(serverStatus(ago(100), 60, now)).toBe('online');
    expect(offlineAfter(15)).toBe(60);
    expect(offlineAfter(60)).toBe(240);
  });
});

describe('summaries', () => {
  it('converts a row to a view', () => {
    const view = toSummary(
      row({
        snapshot: {
          disks: [
            {
              mount: '/',
              device: 'a',
              fs: 'ext4',
              total: 10,
              used: 5,
              pct: 50,
            },
            {
              mount: '/d',
              device: 'b',
              fs: 'ext4',
              total: 10,
              used: 9,
              pct: 90,
            },
          ],
        },
      }),
      { openIncidents: 2, monitorIds: ['m1'], cpuHistory: [1, 2] },
      now,
    );
    expect(view).toMatchObject({
      id: 's1',
      status: 'online',
      memTotal: 8589934592,
      diskMax: 90,
      openIncidents: 2,
      monitorIds: ['m1'],
      cpuHistory: [1, 2],
      containers: null,
      bootTime: ago(86_400).toISOString(),
    });
  });

  it('falls back to the latest disk value and handles a pending server', () => {
    const view = toSummary(
      row({ last_seen_at: null, boot_time: null, latest: { disk: 77 } }),
      { openIncidents: 0, monitorIds: [], cpuHistory: [] },
      now,
    );
    expect(view.diskMax).toBe(77);
    expect(view.status).toBe('pending');
    expect(view.lastSeenAt).toBeNull();
    expect(view.bootTime).toBeNull();
  });

  it('summarises containers', () => {
    const container = (state: string, health = '') => ({
      id: state,
      name: state,
      image: '',
      state,
      health,
      status: '',
      createdAt: 0,
      cpu: null,
      memUsed: null,
      memLimit: null,
      netIn: null,
      netOut: null,
    });
    expect(
      containerSummary(
        [
          container('running'),
          container('exited'),
          container('running', 'unhealthy'),
          container('restarting'),
        ],
        true,
      ),
    ).toEqual({
      total: 4,
      running: 2,
      problems: 2,
    });
    expect(containerSummary(undefined, true)).toBeNull();
    expect(containerSummary([container('running')], false)).toBeNull();
  });
});

describe('tokens and rules', () => {
  const token = (
    patch: Partial<EnrollmentTokenRow> = {},
  ): EnrollmentTokenRow => ({
    id: 't1',
    org_id: 'o1',
    name: 'Production',
    token_hash: 'h',
    prefix: 'ist_abcd',
    max_uses: null,
    uses: 0,
    expires_at: new Date(now.getTime() + 86_400_000),
    revoked_at: null,
    created_by: null,
    created_at: ago(5),
    ...patch,
  });

  it('knows when a token can still be used', () => {
    expect(tokenActive(token(), now)).toBe(true);
    expect(tokenActive(token({ revoked_at: ago(1) }), now)).toBe(false);
    expect(tokenActive(token({ expires_at: ago(1) }), now)).toBe(false);
    expect(tokenActive(token({ max_uses: 2, uses: 2 }), now)).toBe(false);
    expect(tokenActive(token({ max_uses: 2, uses: 1 }), now)).toBe(true);
    expect(toTokenView(token({ max_uses: 3, uses: 1 }), now)).toMatchObject({
      id: 't1',
      prefix: 'ist_abcd',
      uses: 1,
      maxUses: 3,
      active: true,
      revokedAt: null,
    });
  });

  it('converts a rule row', () => {
    const rule: ServerRuleRow = {
      id: 'r1',
      org_id: 'o1',
      name: 'High CPU',
      enabled: true,
      metric: 'cpu',
      mode: 'threshold',
      threshold: 90,
      sensitivity: 'medium',
      target: '',
      severity: 'warning',
      for_sec: 300,
      scope_all: true,
      server_ids: [],
      tags: [],
      channel_ids: ['c1'],
      policy_id: null,
      notify_recovery: true,
      created_at: ago(1),
      updated_at: ago(1),
    };
    expect(toRuleView(rule)).toMatchObject({
      id: 'r1',
      metric: 'cpu',
      threshold: 90,
      forSec: 300,
      scope: { all: true, serverIds: [], tags: [] },
      channelIds: ['c1'],
    });
  });
});
