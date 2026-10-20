export type TimeSortDirection = 'asc' | 'desc';

/** Monday at Shanghai midnight, independent of the browser's own time zone. */
export function shanghaiWeekStart(value: Date): Date {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(value);
  const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
  const start = new Date(`${day}T00:00:00+08:00`);
  start.setUTCDate(start.getUTCDate() - weekday);
  return start;
}

export function compareTimestamps(
  left: string | null | undefined,
  right: string | null | undefined,
  direction: TimeSortDirection = 'asc',
) {
  const leftTime = left ? Date.parse(left) : Number.NaN;
  const rightTime = right ? Date.parse(right) : Number.NaN;
  const leftValid = Number.isFinite(leftTime);
  const rightValid = Number.isFinite(rightTime);

  if (!leftValid) return rightValid ? 1 : 0;
  if (!rightValid) return -1;
  return direction === 'desc' ? rightTime - leftTime : leftTime - rightTime;
}
