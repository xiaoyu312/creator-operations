import type { LiveSchedule } from '../../../shared/types.ts';

export type ScheduleView = 'calendar' | 'list';
export type ScheduleStatusFilter = 'all' | 'pending' | 'completed' | 'cancelled';

const openScheduleStatuses = new Set(['planned', 'rescheduled']);
const scheduleStatuses = new Set<ScheduleStatusFilter>(['all', 'pending', 'completed', 'cancelled']);

export interface SchedulePageState {
  view: ScheduleView;
  weekStart: string;
  status: ScheduleStatusFilter;
}

function isValidDateKey(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function shanghaiDateKey(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function normalizeWeekStart(value: string): string | null {
  if (!isValidDateKey(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  const daysFromMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysFromMonday);
  return date.toISOString().slice(0, 10);
}

export function addDaysToDateKey(value: string, days: number): string {
  if (!isValidDateKey(value)) return value;
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function getScheduleWeekDays(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, index) => addDaysToDateKey(weekStart, index));
}

export function readSchedulePageState(
  params: URLSearchParams,
  now: Date = new Date(),
  linkedScheduleStart?: string | null,
): SchedulePageState {
  const requestedView = params.get('view');
  const statusValue = params.get('status') as ScheduleStatusFilter | null;
  const requestedWeekStart = params.get('weekStart');
  const linkedDate = linkedScheduleStart ? shanghaiDateKey(linkedScheduleStart) : '';
  const fallbackDate = linkedDate || shanghaiDateKey(now);

  return {
    view: requestedView === 'list' ? 'list' : 'calendar',
    weekStart: normalizeWeekStart(requestedWeekStart ?? '')
      ?? normalizeWeekStart(fallbackDate)
      ?? normalizeWeekStart(shanghaiDateKey(now))
      ?? '1970-01-05',
    status: statusValue && scheduleStatuses.has(statusValue) ? statusValue : 'all',
  };
}

export function withSchedulePageState(
  params: URLSearchParams,
  state: Partial<SchedulePageState>,
): URLSearchParams {
  const next = new URLSearchParams(params);
  if (state.view) next.set('view', state.view);
  if (state.weekStart) {
    const normalized = normalizeWeekStart(state.weekStart);
    if (normalized) next.set('weekStart', normalized);
  }
  if (state.status) {
    if (state.status === 'all') next.delete('status');
    else next.set('status', state.status);
  }
  return next;
}

export function filterSchedulesForWeek(
  schedules: LiveSchedule[],
  weekStart: string,
  status: ScheduleStatusFilter,
): LiveSchedule[] {
  const weekEnd = addDaysToDateKey(weekStart, 7);
  return schedules.filter((schedule) => {
    const key = shanghaiDateKey(schedule.plannedStartAt);
    const matchesWeek = key >= weekStart && key < weekEnd;
    const matchesStatus = status === 'all'
      || (status === 'pending' && openScheduleStatuses.has(schedule.status))
      || schedule.status === status;
    return matchesWeek && matchesStatus;
  });
}

export function findScheduleConflicts(
  schedules: LiveSchedule[],
  ownerMemberId: string,
  plannedStartAt: string,
  plannedEndAt: string,
): LiveSchedule[] {
  const start = Date.parse(plannedStartAt);
  const end = Date.parse(plannedEndAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return [];

  return schedules.filter((schedule) => {
    if (schedule.ownerMemberId !== ownerMemberId || !openScheduleStatuses.has(schedule.status)) return false;
    const existingStart = Date.parse(schedule.plannedStartAt);
    const existingEnd = Date.parse(schedule.plannedEndAt);
    return Number.isFinite(existingStart) && Number.isFinite(existingEnd)
      && existingStart < end && existingEnd > start;
  });
}
