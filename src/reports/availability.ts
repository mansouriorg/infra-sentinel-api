export interface Interval {
  start: number;
  end: number;
}

export type WindowRepeat = 'none' | 'daily' | 'weekly';

export interface WindowSpec {
  startsAt: Date;
  durationSec: number;
  repeat: WindowRepeat;
}

export const DAY_MS = 86_400_000;
const REPEAT_MS: Record<Exclude<WindowRepeat, 'none'>, number> = {
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
};
const MAX_OCCURRENCES = 2000;

export function normalize(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals
    .filter(
      (item) =>
        Number.isFinite(item.start) &&
        Number.isFinite(item.end) &&
        item.end > item.start,
    )
    .map((item) => ({ start: item.start, end: item.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const item of sorted) {
    const last = merged[merged.length - 1];
    if (last && item.start <= last.end) {
      if (item.end > last.end) last.end = item.end;
    } else {
      merged.push(item);
    }
  }
  return merged;
}

export function clip(
  intervals: readonly Interval[],
  from: number,
  to: number,
): Interval[] {
  const result: Interval[] = [];
  for (const item of intervals) {
    const start = Math.max(item.start, from);
    const end = Math.min(item.end, to);
    if (end > start) result.push({ start, end });
  }
  return result;
}

export function subtract(
  source: readonly Interval[],
  removed: readonly Interval[],
): Interval[] {
  const base = normalize(source);
  const cut = normalize(removed);
  const result: Interval[] = [];
  let index = 0;
  for (const item of base) {
    let start = item.start;
    while (index < cut.length && cut[index].end <= start) index += 1;
    let cursor = index;
    while (cursor < cut.length && cut[cursor].start < item.end) {
      if (cut[cursor].start > start)
        result.push({ start, end: cut[cursor].start });
      start = Math.max(start, cut[cursor].end);
      if (start >= item.end) break;
      cursor += 1;
    }
    if (start < item.end) result.push({ start, end: item.end });
  }
  return result;
}

export function total(intervals: readonly Interval[]): number {
  let sum = 0;
  for (const item of intervals) sum += item.end - item.start;
  return sum;
}

export function expandWindow(
  window: WindowSpec,
  from: number,
  to: number,
): Interval[] {
  const first = window.startsAt.getTime();
  const length = window.durationSec * 1000;
  if (!Number.isFinite(first) || length <= 0 || to <= from) return [];
  if (window.repeat === 'none') {
    return first < to && first + length > from
      ? [{ start: first, end: first + length }]
      : [];
  }
  const period = REPEAT_MS[window.repeat];
  const earliest = Math.max(0, Math.floor((from - length - first) / period));
  const result: Interval[] = [];
  for (let k = earliest; k < earliest + MAX_OCCURRENCES; k += 1) {
    const start = first + k * period;
    if (start >= to) break;
    if (start + length > from) result.push({ start, end: start + length });
  }
  return result;
}

export interface AvailabilityInput {
  from: number;
  to: number;
  existsFrom: number;
  down: readonly Interval[];
  maintenance: readonly Interval[];
  paused: readonly Interval[];
}

export interface AvailabilityResult {
  startMs: number;
  endMs: number;
  periodMs: number;
  maintenanceMs: number;
  pausedMs: number;
  countedMs: number;
  downMs: number;
  availability: number | null;
}

export function computeAvailability(
  input: AvailabilityInput,
): AvailabilityResult {
  const startMs = Math.max(input.from, input.existsFrom);
  const endMs = input.to;
  if (!(endMs > startMs)) {
    return {
      startMs,
      endMs,
      periodMs: 0,
      maintenanceMs: 0,
      pausedMs: 0,
      countedMs: 0,
      downMs: 0,
      availability: null,
    };
  }
  const maintenance = normalize(clip(input.maintenance, startMs, endMs));
  const paused = subtract(clip(input.paused, startMs, endMs), maintenance);
  const excluded = normalize([...maintenance, ...paused]);
  const periodMs = endMs - startMs;
  const maintenanceMs = total(maintenance);
  const pausedMs = total(paused);
  const countedMs = periodMs - maintenanceMs - pausedMs;
  const down = subtract(clip(normalize(input.down), startMs, endMs), excluded);
  const downMs = Math.min(total(down), Math.max(0, countedMs));
  const availability =
    countedMs > 0 ? Math.max(0, Math.min(1, 1 - downMs / countedMs)) : null;
  return {
    startMs,
    endMs,
    periodMs,
    maintenanceMs,
    pausedMs,
    countedMs,
    downMs,
    availability,
  };
}

export function utcDayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

export function dayStarts(to: number, days: number): number[] {
  const last = utcDayStart(to);
  const result: number[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1)
    result.push(last - offset * DAY_MS);
  return result;
}

export interface DayAvailability {
  day: number;
  availability: number | null;
  downMs: number;
  maintenanceMs: number;
}

export function dailyAvailability(
  base: Omit<AvailabilityInput, 'from' | 'to'>,
  days: readonly number[],
  now: number,
): DayAvailability[] {
  return days.map((day) => {
    const result = computeAvailability({
      ...base,
      from: day,
      to: Math.min(day + DAY_MS, now),
    });
    return {
      day,
      availability: result.availability,
      downMs: result.downMs,
      maintenanceMs: result.maintenanceMs,
    };
  });
}

export function allowedDowntimeMs(
  countedMs: number,
  targetPercent: number,
): number {
  return Math.max(0, countedMs * (1 - targetPercent / 100));
}

export function formatAvailability(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  if (value >= 1) return '100%';
  const floored = Math.floor(value * 100_000 + 1e-6) / 1000;
  let text = floored.toFixed(3);
  while (text.endsWith('0') && /\.\d\d\d$/.test(text)) text = text.slice(0, -1);
  return `${text}%`;
}

export function formatSpan(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds === 0) return '0s';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return seconds % 60 && minutes < 10
      ? `${minutes}m ${seconds % 60}s`
      : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48)
    return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}
