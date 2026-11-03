import { reportQuerySchema } from './report.schema';

const first = '8d1a5f0e-2f4c-4b8e-9f2a-3b6c1d7e9a10';
const second = '3f2b8c3a-6d4e-4a1b-8c5d-7e9f0a1b2c3d';

describe('reportQuerySchema', () => {
  it('splits comma separated ids and tags and drops empty parts', () => {
    const result = reportQuerySchema.parse({
      monitorIds: `${first}, ${second}`,
      serverIds: '',
      tags: ' Prod ,eu-west,,',
    });
    expect(result.monitorIds).toEqual([first, second]);
    expect(result.serverIds).toEqual([]);
    expect(result.tags).toEqual(['prod', 'eu-west']);
  });

  it('uses defaults when nothing is given', () => {
    const result = reportQuerySchema.parse({});
    expect(result.period).toBe('last30');
    expect(result.target).toBe(99.9);
    expect(result.includeDegraded).toBe(false);
    expect(result.format).toBe('json');
    expect(result.monitorIds).toEqual([]);
    expect(result.serverIds).toEqual([]);
    expect(result.tags).toEqual([]);
  });

  it('reads the flags and the target from query strings', () => {
    const result = reportQuerySchema.parse({
      includeDegraded: 'true',
      target: '99.95',
      format: 'csv',
    });
    expect(result.includeDegraded).toBe(true);
    expect(result.target).toBe(99.95);
    expect(result.format).toBe('csv');
  });

  it('rejects ids and tags that are not valid', () => {
    expect(reportQuerySchema.safeParse({ monitorIds: 'nope' }).success).toBe(
      false,
    );
    expect(
      reportQuerySchema.safeParse({ serverIds: `${first},nope` }).success,
    ).toBe(false);
    expect(reportQuerySchema.safeParse({ tags: 'bad tag!' }).success).toBe(
      false,
    );
  });

  it('limits how many ids and tags can be given', () => {
    const ids = Array.from({ length: 301 }, () => first).join(',');
    const tags = Array.from({ length: 21 }, (_, index) => `t${index}`).join(
      ',',
    );
    expect(reportQuerySchema.safeParse({ monitorIds: ids }).success).toBe(
      false,
    );
    expect(reportQuerySchema.safeParse({ tags }).success).toBe(false);
    expect(
      reportQuerySchema.safeParse({
        monitorIds: Array.from({ length: 300 }, () => first).join(','),
      }).success,
    ).toBe(true);
  });

  it('rejects a target outside 50 to 100', () => {
    expect(reportQuerySchema.safeParse({ target: '49' }).success).toBe(false);
    expect(reportQuerySchema.safeParse({ target: '101' }).success).toBe(false);
  });
});
