const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};
const STEP_MS = 15 * 60_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, found);
  }
  return found;
}

export interface LocalParts {
  weekday: number;
  hour: number;
  minute: number;
}

export function localParts(ms: number, timeZone: string): LocalParts {
  const parts = formatter(timeZone).formatToParts(new Date(ms));
  const pick = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return {
    weekday: WEEKDAYS[pick('weekday')] ?? 0,
    hour: Number(pick('hour')) % 24,
    minute: Number(pick('minute')),
  };
}

export function latestScheduledAt(
  now: number,
  weekday: number,
  hour: number,
  timeZone: string,
): number {
  let cursor = Math.floor(now / STEP_MS) * STEP_MS;
  for (let step = 0; step <= 7 * 96 + 1; step += 1) {
    const parts = localParts(cursor, timeZone);
    if (parts.weekday === weekday && parts.hour === hour && parts.minute === 0)
      return cursor;
    cursor -= STEP_MS;
  }
  return Math.floor(now / STEP_MS) * STEP_MS;
}

export function isDue(
  now: number,
  lastSentAt: number | null,
  settings: { weekday: number; hour: number; timeZone: string },
  graceMs = 12 * 3_600_000,
): { due: boolean; scheduledAt: number } {
  const scheduledAt = latestScheduledAt(
    now,
    settings.weekday,
    settings.hour,
    settings.timeZone,
  );
  const sentThisCycle = lastSentAt !== null && lastSentAt >= scheduledAt;
  return {
    due: !sentThisCycle && now >= scheduledAt && now - scheduledAt < graceMs,
    scheduledAt,
  };
}

export function describeSchedule(
  weekday: number,
  hour: number,
  timeZone: string,
): string {
  const names = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ];
  return `${names[weekday] ?? 'Monday'} at ${String(hour).padStart(2, '0')}:00 (${timeZone})`;
}
