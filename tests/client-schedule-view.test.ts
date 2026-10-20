import assert from 'node:assert/strict';
import test from 'node:test';
import type { LiveSchedule } from '../shared/types.ts';
import {
  filterSchedulesForWeek,
  findScheduleConflicts,
  getScheduleWeekDays,
  readSchedulePageState,
  withSchedulePageState,
} from '../client/src/lib/schedule-view.ts';

function schedule(overrides: Partial<LiveSchedule> = {}): LiveSchedule {
  return {
    id: 'schedule-1', orgId: 'org-1', teamId: 'team-1', creatorId: 'creator-1', cooperationId: 'cooperation-1',
    cooperationLineId: null, ownerMemberId: 'member-1', platform: 'douyin', roomId: null, title: '品牌专场',
    plannedStartAt: '2026-10-14T10:00:00+08:00', plannedEndAt: '2026-10-14T11:00:00+08:00', history: [],
    status: 'planned', changeReason: null, actualStartAt: null, actualEndAt: null, reviewUrl: null,
    version: 1, createdAt: '2026-10-01T09:00:00+08:00', createdBy: 'member-1',
    updatedAt: '2026-10-01T09:00:00+08:00', updatedBy: 'member-1',
    ...overrides,
  };
}

test('排期深链在没有明确周范围时定位到对应周，明确的 weekStart 优先', () => {
  const linkedScheduleStart = '2026-10-18T15:30:00Z';
  const params = new URLSearchParams('scheduleId=old-session&brandId=brand-a');
  const state = readSchedulePageState(params, new Date('2026-10-28T04:00:00Z'), linkedScheduleStart);

  assert.equal(state.weekStart, '2026-10-12');
  assert.deepEqual(getScheduleWeekDays(state.weekStart), [
    '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18',
  ]);
  assert.equal(readSchedulePageState(new URLSearchParams('weekStart=2026-10-26'), new Date(), linkedScheduleStart).weekStart, '2026-10-26');
});

test('周范围和状态筛选共用计划开始时间的上海日期', () => {
  const records = [
    schedule({ id: 'sunday-last-minute', plannedStartAt: '2026-10-18T15:59:00Z', status: 'planned' }),
    schedule({ id: 'monday-next-week', plannedStartAt: '2026-10-18T16:00:00Z', status: 'planned' }),
    schedule({ id: 'completed', status: 'completed' }),
    schedule({ id: 'cancelled', status: 'cancelled' }),
  ];

  assert.deepEqual(filterSchedulesForWeek(records, '2026-10-12', 'all').map((item) => item.id), ['sunday-last-minute', 'completed', 'cancelled']);
  assert.deepEqual(filterSchedulesForWeek(records, '2026-10-12', 'pending').map((item) => item.id), ['sunday-last-minute']);
  assert.deepEqual(filterSchedulesForWeek(records, '2026-10-19', 'all').map((item) => item.id), ['monday-next-week']);
});

test('冲突仅提示同一负责人的开放场次严格重叠，端点相接、取消和已完成不算', () => {
  const existing = [
    schedule({ id: 'overlap', plannedStartAt: '2026-10-14T10:00:00+08:00', plannedEndAt: '2026-10-14T11:00:00+08:00' }),
    schedule({ id: 'touching', plannedStartAt: '2026-10-14T11:00:00+08:00', plannedEndAt: '2026-10-14T12:00:00+08:00' }),
    schedule({ id: 'other-owner', ownerMemberId: 'member-2' }),
    schedule({ id: 'cancelled', status: 'cancelled' }),
    schedule({ id: 'completed', status: 'completed' }),
  ];

  assert.deepEqual(findScheduleConflicts(existing, 'member-1', '2026-10-14T02:30:00Z', '2026-10-14T03:00:00Z').map((item) => item.id), ['overlap']);
  assert.deepEqual(findScheduleConflicts(existing, 'member-1', '2026-10-14T09:00:00+08:00', '2026-10-14T10:00:00+08:00'), []);
  assert.deepEqual(findScheduleConflicts(existing, 'member-1', 'invalid', '2026-10-14T12:00:00+08:00'), []);
});

test('视图、周日期和状态更新保留品牌及业务对象深链参数', () => {
  const original = new URLSearchParams('brandId=brand-a&scheduleId=session-7&creatorId=creator-4&cooperationId=coop-3&status=pending&view=calendar&weekStart=2026-10-12');
  const next = withSchedulePageState(original, { view: 'list', weekStart: '2026-10-19' });
  const parsed = readSchedulePageState(next, new Date('2026-10-15T00:00:00Z'));

  assert.equal(parsed.view, 'list');
  assert.equal(parsed.weekStart, '2026-10-19');
  assert.equal(parsed.status, 'pending');
  for (const [key, value] of [['brandId', 'brand-a'], ['scheduleId', 'session-7'], ['creatorId', 'creator-4'], ['cooperationId', 'coop-3']] as const) {
    assert.equal(next.get(key), value);
  }

  const allStatuses = withSchedulePageState(next, { status: 'all' });
  assert.equal(allStatuses.has('status'), false);
  assert.equal(allStatuses.get('view'), 'list');
  assert.equal(allStatuses.get('scheduleId'), 'session-7');
});
