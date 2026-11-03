export type DateLike = Date | string | number;

export function toDate(value: DateLike): Date {
  return value instanceof Date ? value : new Date(value);
}

export function toMs(value: DateLike): number {
  return toDate(value).getTime();
}

export function toIso(value: DateLike): string {
  return toDate(value).toISOString();
}

export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; message?: string };
  return (
    candidate.code === '23505' ||
    /duplicate key value violates unique constraint/i.test(
      candidate.message ?? '',
    )
  );
}
