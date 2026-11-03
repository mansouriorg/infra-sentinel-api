import { bearerKey, normalizeSamples, normalizeTarget } from './agent.service';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const sec = (offset: number) => Math.floor(NOW / 1000) + offset;

function sample(at: number, overrides: Record<string, number> = {}) {
  return {
    at,
    cpu: 10,
    mem: 20,
    memUsed: 1000,
    swap: 0,
    load1: 0.5,
    load5: 0.4,
    load15: 0.3,
    disk: 40,
    netIn: 100,
    netOut: 50,
    ...overrides,
  };
}

describe('bearerKey', () => {
  it('reads an agent key from the header', () => {
    expect(bearerKey('Bearer isk_abcdefghijklmnopqrstuvwxyz')).toBe(
      'isk_abcdefghijklmnopqrstuvwxyz',
    );
  });

  it('rejects other headers', () => {
    expect(bearerKey(undefined)).toBeNull();
    expect(bearerKey('Basic abc')).toBeNull();
    expect(bearerKey('Bearer ist_abcdefghijklmnopqrstuvwxyz')).toBeNull();
    expect(bearerKey('Bearer isk_short')).toBeNull();
  });
});

describe('normalizeTarget', () => {
  it('accepts common names for architectures', () => {
    expect(normalizeTarget('Linux', 'x86_64')).toEqual({
      os: 'linux',
      arch: 'amd64',
    });
    expect(normalizeTarget('darwin', 'aarch64')).toEqual({
      os: 'darwin',
      arch: 'arm64',
    });
  });

  it('rejects anything else', () => {
    expect(() => normalizeTarget('windows', 'amd64')).toThrow();
    expect(() => normalizeTarget('linux', 'mips')).toThrow();
    expect(() => normalizeTarget('../etc', 'amd64')).toThrow();
  });
});

describe('normalizeSamples', () => {
  it('sorts samples, removes duplicates and picks the newest as latest', () => {
    const result = normalizeSamples(
      [sample(sec(-10)), sample(sec(-30)), sample(sec(-10), { cpu: 99 })],
      NOW,
      14,
    );
    expect(result.rows.map((row) => row.at)).toEqual([sec(-30), sec(-10)]);
    expect(result.latest?.cpu).toBe(99);
    expect(result.latest?.at).toBe(new Date(sec(-10) * 1000).toISOString());
  });

  it('drops samples older than the retention or too far in the future', () => {
    const result = normalizeSamples(
      [
        sample(sec(-15 * 86400)),
        sample(sec(500)),
        sample(sec(60)),
        sample(sec(-5)),
      ],
      NOW,
      14,
    );
    expect(result.rows.map((row) => row.at)).toEqual([sec(-5), sec(60)]);
  });

  it('clamps values into sane ranges and renames the network columns', () => {
    const result = normalizeSamples(
      [sample(sec(-1), { cpu: 250, mem: -5, disk: 101, netIn: 5, netOut: 7 })],
      NOW,
      14,
    );
    expect(result.rows[0]).toMatchObject({
      cpu: 100,
      mem: 0,
      disk: 100,
      net_in: 5,
      net_out: 7,
    });
  });

  it('returns no latest when nothing is usable', () => {
    expect(normalizeSamples([], NOW, 14)).toEqual({ rows: [], latest: null });
    expect(
      normalizeSamples([sample(sec(-20 * 86400))], NOW, 14).latest,
    ).toBeNull();
  });
});
