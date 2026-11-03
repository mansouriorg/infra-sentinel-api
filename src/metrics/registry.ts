export type Labels = Record<string, string>;

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_SERIES = 2000;

function escapeValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

function escapeHelp(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

export function formatNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return String(value);
}

function seriesKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}\u0000${labels[key]}`)
    .join('\u0001');
}

function labelText(labels: Labels, extra?: [string, string]): string {
  const pairs = Object.keys(labels)
    .sort()
    .map((key) => `${key}="${escapeValue(labels[key])}"`);
  if (extra) pairs.push(`${extra[0]}="${escapeValue(extra[1])}"`);
  return pairs.length > 0 ? `{${pairs.join(',')}}` : '';
}

function checkLabels(labels: Labels): void {
  for (const key of Object.keys(labels)) {
    if (!LABEL.test(key) || key.startsWith('__'))
      throw new Error(`Invalid metric label name: ${key}`);
  }
}

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly type: 'counter' | 'gauge' | 'histogram',
  ) {
    if (!NAME.test(name)) throw new Error(`Invalid metric name: ${name}`);
  }

  abstract lines(): string[];
  abstract clear(): void;

  render(): string[] {
    const body = this.lines();
    if (body.length === 0) return [];
    return [
      `# HELP ${this.name} ${escapeHelp(this.help)}`,
      `# TYPE ${this.name} ${this.type}`,
      ...body,
    ];
  }
}

export class Counter extends Metric {
  private readonly values = new Map<
    string,
    { labels: Labels; value: number }
  >();

  constructor(name: string, help: string) {
    super(name, help, 'counter');
  }

  inc(labels: Labels = {}, by = 1): void {
    if (!(by >= 0) || !Number.isFinite(by)) return;
    checkLabels(labels);
    const key = seriesKey(labels);
    const current = this.values.get(key);
    if (current) {
      current.value += by;
      return;
    }
    if (this.values.size >= MAX_SERIES) return;
    this.values.set(key, { labels: { ...labels }, value: by });
  }

  setTotal(labels: Labels, total: number): void {
    if (!Number.isFinite(total) || total < 0) return;
    checkLabels(labels);
    const key = seriesKey(labels);
    const current = this.values.get(key);
    if (current) {
      if (total > current.value) current.value = total;
      return;
    }
    if (this.values.size >= MAX_SERIES) return;
    this.values.set(key, { labels: { ...labels }, value: total });
  }

  value(labels: Labels = {}): number {
    return this.values.get(seriesKey(labels))?.value ?? 0;
  }

  clear(): void {
    this.values.clear();
  }

  lines(): string[] {
    return [...this.values.values()]
      .sort((a, b) => seriesKey(a.labels).localeCompare(seriesKey(b.labels)))
      .map(
        (entry) =>
          `${this.name}${labelText(entry.labels)} ${formatNumber(entry.value)}`,
      );
  }
}

export class Gauge extends Metric {
  private readonly values = new Map<
    string,
    { labels: Labels; value: number }
  >();

  constructor(name: string, help: string) {
    super(name, help, 'gauge');
  }

  set(labels: Labels, value: number): void;
  set(value: number): void;
  set(first: Labels | number, second?: number): void {
    const labels = typeof first === 'number' ? {} : first;
    const value = typeof first === 'number' ? first : (second as number);
    if (typeof value !== 'number') return;
    checkLabels(labels);
    const key = seriesKey(labels);
    if (!this.values.has(key) && this.values.size >= MAX_SERIES) return;
    this.values.set(key, { labels: { ...labels }, value });
  }

  value(labels: Labels = {}): number | undefined {
    return this.values.get(seriesKey(labels))?.value;
  }

  clear(): void {
    this.values.clear();
  }

  lines(): string[] {
    return [...this.values.values()]
      .sort((a, b) => seriesKey(a.labels).localeCompare(seriesKey(b.labels)))
      .map(
        (entry) =>
          `${this.name}${labelText(entry.labels)} ${formatNumber(entry.value)}`,
      );
  }
}

export class Histogram extends Metric {
  private readonly values = new Map<
    string,
    { labels: Labels; counts: number[]; sum: number; count: number }
  >();

  constructor(
    name: string,
    help: string,
    private readonly buckets: number[],
  ) {
    super(name, help, 'histogram');
    if (
      buckets.length === 0 ||
      buckets.some((bound, index) => index > 0 && bound <= buckets[index - 1])
    ) {
      throw new Error(`Histogram buckets for ${name} must be increasing`);
    }
  }

  observe(labels: Labels, value: number): void {
    if (!Number.isFinite(value)) return;
    checkLabels(labels);
    if ('le' in labels) throw new Error('The label name le is reserved');
    const key = seriesKey(labels);
    let entry = this.values.get(key);
    if (!entry) {
      if (this.values.size >= MAX_SERIES) return;
      entry = {
        labels: { ...labels },
        counts: this.buckets.map(() => 0),
        sum: 0,
        count: 0,
      };
      this.values.set(key, entry);
    }
    for (let index = 0; index < this.buckets.length; index += 1) {
      if (value <= this.buckets[index]) entry.counts[index] += 1;
    }
    entry.sum += value;
    entry.count += 1;
  }

  count(labels: Labels = {}): number {
    return this.values.get(seriesKey(labels))?.count ?? 0;
  }

  clear(): void {
    this.values.clear();
  }

  lines(): string[] {
    const out: string[] = [];
    const entries = [...this.values.values()].sort((a, b) =>
      seriesKey(a.labels).localeCompare(seriesKey(b.labels)),
    );
    for (const entry of entries) {
      this.buckets.forEach((bound, index) => {
        out.push(
          `${this.name}_bucket${labelText(entry.labels, ['le', formatNumber(bound)])} ${entry.counts[index]}`,
        );
      });
      out.push(
        `${this.name}_bucket${labelText(entry.labels, ['le', '+Inf'])} ${entry.count}`,
      );
      out.push(
        `${this.name}_sum${labelText(entry.labels)} ${formatNumber(entry.sum)}`,
      );
      out.push(`${this.name}_count${labelText(entry.labels)} ${entry.count}`);
    }
    return out;
  }
}

export class Registry {
  private readonly metrics = new Map<string, Metric>();

  private add<T extends Metric>(metric: T): T {
    if (this.metrics.has(metric.name))
      throw new Error(`Metric ${metric.name} is already registered`);
    this.metrics.set(metric.name, metric);
    return metric;
  }

  counter(name: string, help: string): Counter {
    return this.add(new Counter(name, help));
  }

  gauge(name: string, help: string): Gauge {
    return this.add(new Gauge(name, help));
  }

  histogram(name: string, help: string, buckets: number[]): Histogram {
    return this.add(new Histogram(name, help, buckets));
  }

  render(): string {
    const lines: string[] = [];
    for (const metric of [...this.metrics.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      lines.push(...metric.render());
    }
    return lines.length > 0 ? `${lines.join('\n')}\n` : '';
  }
}
