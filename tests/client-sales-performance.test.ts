import assert from 'node:assert/strict';
import test from 'node:test';
import type { SalesPerformanceWorkspaceItem, WorkspaceSnapshot } from '../shared/types.ts';
import { parseYuanToCents, shortVideoPeriodBounds, summarizeSalesPerformance, type SalesPerformanceFilters } from '../client/src/lib/sales-performance.ts';

function report(id: string, patch: Partial<SalesPerformanceWorkspaceItem> = {}): SalesPerformanceWorkspaceItem {
  return {
    id,
    orgId: 'org-a',
    teamId: 'team-a',
    creatorId: `creator-${id}`,
    creatorAccountId: `account-${id}`,
    platform: 'douyin',
    externalAccountId: `handle-${id}`,
    storeId: 'store-a',
    shopId: 'external-shop-a',
    commerceType: 'short_video',
    title: `内容 ${id}`,
    contentId: `video-${id}`,
    contentUrl: null,
    productIds: ['product-a'],
    periodStartAt: '2026-10-15T00:00:00+08:00',
    periodEndAt: '2026-10-16T00:00:00+08:00',
    creditedOn: '2026-10-15',
    gmvCents: 12_345,
    orderCount: null,
    ownerMemberId: 'member-a',
    evidenceUrl: null,
    evidenceNote: '平台结算页',
    status: 'approved',
    submittedAt: '2026-10-16T01:00:00.000Z',
    reviewedBy: 'manager-a',
    reviewedAt: '2026-10-16T02:00:00.000Z',
    reviewNote: null,
    reconciledBy: null,
    reconciledAt: null,
    reconciliationNote: null,
    version: 1,
    createdAt: '2026-10-16T01:00:00.000Z',
    updatedAt: '2026-10-16T02:00:00.000Z',
    createdBy: 'member-a',
    updatedBy: 'manager-a',
    accountingStatus: 'counted',
    overlappingOrderCount: 0,
    ...patch,
  };
}

function filters(patch: Partial<SalesPerformanceFilters> = {}): SalesPerformanceFilters {
  return {
    dateFrom: '2026-10-01',
    dateTo: '2026-10-31',
    platform: 'all',
    shopId: 'all',
    shopPlatform: 'all',
    teamId: 'all',
    ownerMemberId: 'all',
    status: 'all',
    ...patch,
  };
}

function workspace(salesReports: SalesPerformanceWorkspaceItem[]): Pick<WorkspaceSnapshot, 'salesReports' | 'scope' | 'members' | 'teams'> {
  return {
    salesReports,
    scope: { teamIds: ['team-a'], canSeeTeamMetrics: true, canManageMembers: true },
    members: [
      { id: 'member-a', displayName: '商务 A', role: null, teamId: 'team-a', active: true, version: 1 },
      { id: 'member-b', displayName: '商务 B', role: null, teamId: 'team-a', active: true, version: 1 },
    ],
    teams: [{ id: 'team-a', orgId: 'org-a', name: '商务一组', active: true, version: 1 }],
  };
}

test('短视频日期按 inclusive end 转为次日零点的上海半开区间', () => {
  assert.deepEqual(shortVideoPeriodBounds('2026-10-15', '2026-10-15'), {
    periodStartAt: '2026-10-14T16:00:00.000Z',
    periodEndAt: '2026-10-15T16:00:00.000Z',
    creditedOn: '2026-10-15',
  });
});

test('短视频日期校验拒绝非法日期、反向区间和跨月区间', () => {
  assert.throws(() => shortVideoPeriodBounds('2026-02-30', '2026-02-30'), /有效/);
  assert.throws(() => shortVideoPeriodBounds('2026-10-16', '2026-10-15'), /早于/);
  assert.throws(() => shortVideoPeriodBounds('2026-10-31', '2026-11-01'), /跨月/);
});

test('金额按元转分且不接受超过两位小数', () => {
  assert.equal(parseYuanToCents('1200.3'), 120_030);
  assert.equal(parseYuanToCents('0.01'), 1);
  assert.equal(parseYuanToCents('12.345'), null);
  assert.equal(parseYuanToCents('-1'), null);
});

test('团队汇总只计入服务端标记 counted 的手工贡献，并单列待核对与待对账', () => {
  const records = [
    report('counted'),
    report('pending', { ownerMemberId: 'member-b', status: 'pending_review', accountingStatus: 'unreviewed', gmvCents: 30_000 }),
    report('returned', { ownerMemberId: 'member-b', status: 'returned', accountingStatus: 'returned', gmvCents: 8_000 }),
    report('reconcile', { accountingStatus: 'reconciliation_required', gmvCents: 4_000, overlappingOrderCount: null }),
    report('replaced', { accountingStatus: 'replaced_by_orders', gmvCents: 70_000 }),
  ];
  const result = summarizeSalesPerformance({ workspace: workspace(records), actor: { memberId: 'manager-a', role: 'manager' }, filters: filters() });
  assert.equal(result.countedManualCents, 12_345);
  assert.equal(result.countedCount, 1);
  assert.equal(result.pendingReviewCount, 1);
  assert.equal(result.returnedCount, 1);
  assert.equal(result.reconciliationRequiredCount, 1);
  assert.equal(result.reconciliationRequiredCents, 4_000);
  assert.equal(result.hasUnquantifiedOverlap, true);
  assert.equal(result.overlappingOrderCount, null);
  assert.equal(result.replacedByOrdersCount, 1);
  assert.equal(result.memberRows.find((row) => row.memberId === 'member-b')?.countedGmvCents, 0);
});

test('填报汇总按冻结店铺、平台、日期、成员和当前商务身份过滤', () => {
  const records = [
    report('match'),
    report('wrong-shop', { shopId: 'external-shop-b' }),
    report('wrong-platform', { platform: 'channels', shopId: 'external-shop-a' }),
    report('wrong-date', { creditedOn: '2026-11-01' }),
    report('other-owner', { ownerMemberId: 'member-b' }),
  ];
  const result = summarizeSalesPerformance({
    workspace: workspace(records),
    actor: { memberId: 'member-a', role: 'bd' },
    filters: filters({ dateFrom: '2026-10-15', dateTo: '2026-10-15', platform: 'douyin', shopId: 'external-shop-a', shopPlatform: 'douyin' }),
  });
  assert.deepEqual(result.reports.map((item) => item.id), ['match']);
  assert.equal(result.countedManualCents, 12_345);
});
