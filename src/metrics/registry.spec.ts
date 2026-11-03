import { Registry, formatNumber } from './registry';

describe('Registry', () => {
  it('renders counters with help, type and sorted labels', () => {
    const registry = new Registry();
    const requests = registry.counter('app_requests_total', 'Requests served.');
    requests.inc({ method: 'GET', status: '200' });
    requests.inc({ status: '200', method: 'GET' }, 2);
    requests.inc({ method: 'POST', status: '500' });

    expect(requests.value({ method: 'GET', status: '200' })).toBe(3);
    expect(registry.render()).toBe(
      [
        '# HELP app_requests_total Requests served.',
        '# TYPE app_requests_total counter',
        'app_requests_total{method="GET",status="200"} 3',
        'app_requests_total{method="POST",status="500"} 1',
        '',
      ].join('\n'),
    );
  });

  it('ignores negative and non-finite increments', () => {
    const registry = new Registry();
    const counter = registry.counter('app_total', 'Total.');
    counter.inc({}, -1);
    counter.inc({}, Number.NaN);
    counter.inc({}, Infinity);
    counter.inc();

    expect(counter.value()).toBe(1);
  });

  it('only moves a counter total forward', () => {
    const registry = new Registry();
    const counter = registry.counter('cpu_seconds_total', 'CPU.');
    counter.setTotal({}, 5);
    counter.setTotal({}, 3);
    counter.setTotal({}, -2);
    counter.setTotal({}, 7.5);

    expect(counter.value()).toBe(7.5);
  });

  it('renders gauges and replaces values', () => {
    const registry = new Registry();
    const gauge = registry.gauge('app_monitors', 'Monitors.');
    gauge.set({ status: 'up' }, 4);
    gauge.set({ status: 'up' }, 5);
    gauge.set({ status: 'down' }, 1);

    expect(gauge.value({ status: 'up' })).toBe(5);
    expect(gauge.value({ status: 'missing' })).toBeUndefined();
    expect(registry.render()).toContain(
      'app_monitors{status="down"} 1\napp_monitors{status="up"} 5\n',
    );
  });

  it('accepts a plain value for gauges without labels', () => {
    const registry = new Registry();
    const gauge = registry.gauge('app_up', 'Up.');
    gauge.set(1);

    expect(registry.render()).toContain('\napp_up 1\n');
  });

  it('leaves out metrics that have no series yet', () => {
    const registry = new Registry();
    registry.counter('app_unused_total', 'Unused.');
    registry.gauge('app_used', 'Used.').set({ a: 'b' }, 1);

    const text = registry.render();
    expect(text).not.toContain('app_unused_total');
    expect(text).toContain('app_used{a="b"} 1');
  });

  it('renders cumulative histogram buckets with sum and count', () => {
    const registry = new Registry();
    const histogram = registry.histogram('app_seconds', 'Duration.', [0.1, 1]);
    histogram.observe({ route: '/a' }, 0.05);
    histogram.observe({ route: '/a' }, 0.5);
    histogram.observe({ route: '/a' }, 3);

    expect(histogram.count({ route: '/a' })).toBe(3);
    const text = registry.render();
    expect(text).toContain('# TYPE app_seconds histogram');
    expect(text).toContain('app_seconds_bucket{route="/a",le="0.1"} 1');
    expect(text).toContain('app_seconds_bucket{route="/a",le="1"} 2');
    expect(text).toContain('app_seconds_bucket{route="/a",le="+Inf"} 3');
    expect(text).toContain('app_seconds_sum{route="/a"} 3.55');
    expect(text).toContain('app_seconds_count{route="/a"} 3');
  });

  it('puts a value on the boundary in that bucket', () => {
    const registry = new Registry();
    const histogram = registry.histogram('app_edge_seconds', 'Edge.', [1, 2]);
    histogram.observe({}, 1);

    expect(registry.render()).toContain('app_edge_seconds_bucket{le="1"} 1');
  });

  it('escapes label values and help text', () => {
    const registry = new Registry();
    const gauge = registry.gauge('app_weird', 'Line one\nline two \\ end');
    gauge.set({ value: 'a"b\\c\nd' }, 1);

    const text = registry.render();
    expect(text).toContain('# HELP app_weird Line one\\nline two \\\\ end');
    expect(text).toContain('app_weird{value="a\\"b\\\\c\\nd"} 1');
  });

  it('rejects invalid names, labels, buckets and duplicates', () => {
    const registry = new Registry();
    expect(() => registry.counter('1bad', 'x')).toThrow(/Invalid metric name/);
    expect(() => registry.counter('has space', 'x')).toThrow(
      /Invalid metric name/,
    );
    registry.counter('app_ok_total', 'x');
    expect(() => registry.gauge('app_ok_total', 'x')).toThrow(
      /already registered/,
    );
    expect(() => registry.histogram('app_bad_seconds', 'x', [])).toThrow(
      /increasing/,
    );
    expect(() => registry.histogram('app_bad2_seconds', 'x', [1, 1])).toThrow(
      /increasing/,
    );
    expect(() =>
      registry.gauge('app_g', 'x').set({ 'bad-label': 'v' }, 1),
    ).toThrow(/Invalid metric label/);
    expect(() =>
      registry.gauge('app_h', 'x').set({ __hidden: 'v' }, 1),
    ).toThrow(/Invalid metric label/);
    expect(() =>
      registry.histogram('app_le_seconds', 'x', [1]).observe({ le: '1' }, 1),
    ).toThrow(/reserved/);
  });

  it('caps the number of series so labels cannot grow without bound', () => {
    const registry = new Registry();
    const counter = registry.counter('app_capped_total', 'Capped.');
    for (let index = 0; index < 2500; index += 1)
      counter.inc({ id: String(index) });

    expect(
      registry
        .render()
        .split('\n')
        .filter((line) => line.startsWith('app_capped_total{')).length,
    ).toBe(2000);
    counter.inc({ id: '0' });
    expect(counter.value({ id: '0' })).toBe(2);
  });

  it('clears series', () => {
    const registry = new Registry();
    const gauge = registry.gauge('app_clear', 'Clear.');
    gauge.set({ a: '1' }, 1);
    gauge.clear();

    expect(registry.render()).toBe('');
  });

  it('formats special numbers', () => {
    expect(formatNumber(Number.NaN)).toBe('NaN');
    expect(formatNumber(Infinity)).toBe('+Inf');
    expect(formatNumber(-Infinity)).toBe('-Inf');
    expect(formatNumber(0.25)).toBe('0.25');
  });
});
