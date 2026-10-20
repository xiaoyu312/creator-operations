import type { SalesPerformanceWorkspaceItem, WorkspaceSnapshot } from '../../../shared/types.ts';
import type { OrderViewPlatform } from './order-view.ts';

export type SalesReportStatusFilter = 'all' | 'pending_review' | 'approved' | 'returned' | 'reconciliation_required' | 'replaced_by_orders';

export interface SalesPerformanceFilters {
  dateFrom: string;
  dateTo: string;
  platform: OrderViewPlatform;
  shopId: string;
  shopPlatform: OrderViewPlatform;
  teamId: string;
  ownerMemberId: string;
  status: SalesReportStatusFilter;
}

export interface SalesPerformanceMemberSummary {
  memberId: string;
  memberName: string;
  teamId: string;
  teamName: string;
  countedGmvCents: number;
  countedReportCount: number;
  pendingReviewCount: number;
  returnedCount: number;
  reconciliationRequiredCount: number;
  reconciliationRequiredCents: number;
  replacedByOrdersCount: number;
}

export interface SalesPerformanceSummary {
  reports: SalesPerformanceWorkspaceItem[];
  memberRows: SalesPerformanceMemberSummary[];
  countedManualCents: number;
  countedCount: number;
  pendingReviewCount: number;
  returnedCount: number;
  reconciliationRequiredCount: number;
  reconciliationRequiredCents: number;
  overlappingOrderCount: number | null;
  hasUnquantifiedOverlap: boolean;
  replacedByOrdersCount: number;
}

type SalesWorkspaceSlice = Pick<WorkspaceSnapshot, 'salesReports' | 'scope' | 'members' | 'teams'>;

/**
 * Uses the accounting status computed by the server from the complete brand order set.
 * The client must never infer order overlap from its filtered order rows.
 */
export function summarizeSalesPerformance({ workspace, actor, filters }: {
  workspace: SalesWorkspaceSlice;
  actor: Pick<WorkspaceSnapshot['actor'], 'memberId' | 'role'>;
  filters: SalesPerformanceFilters;
}): SalesPerformanceSummary {
  const allowedTeamIds = new Set(workspace.scope.teamIds);
  const teamsById = new Map(workspace.teams.map((team) => [team.id, team]));
  const reports = (workspace.salesReports ?? [])
    .filter((report) => {
      if (!allowedTeamIds.has(report.teamId)) return false;
      if (actor.role === 'bd' && report.ownerMemberId !== actor.memberId) return false;
      if (filters.dateFrom && report.creditedOn < filters.dateFrom) return false;
      if (filters.dateTo && report.creditedOn > filters.dateTo) return false;
      if (filters.platform !== 'all' && report.platform !== filters.platform) return false;
      if (filters.shopId !== 'all' && (report.shopId !== filters.shopId || (filters.shopPlatform !== 'all' && report.platform !== filters.shopPlatform))) return false;
      if (filters.teamId !== 'all' && report.teamId !== filters.teamId) return false;
      if (filters.ownerMemberId !== 'all' && report.ownerMemberId !== filters.ownerMemberId) return false;
      if (filters.status === 'pending_review' && report.status !== 'pending_review') return false;
      if (filters.status === 'approved' && report.status !== 'approved') return false;
      if (filters.status === 'returned' && report.status !== 'returned') return false;
      if (filters.status === 'reconciliation_required' && report.accountingStatus !== 'reconciliation_required') return false;
      if (filters.status === 'replaced_by_orders' && report.accountingStatus !== 'replaced_by_orders') return false;
      return true;
    })
    .sort((left, right) => right.creditedOn.localeCompare(left.creditedOn) || right.submittedAt.localeCompare(left.submittedAt));

  const rowsByMember = new Map<string, SalesPerformanceMemberSummary>();
  for (const member of workspace.members) {
    if (!allowedTeamIds.has(member.teamId) || !member.active) continue;
    if (actor.role === 'bd' && member.id !== actor.memberId) continue;
    if (filters.teamId !== 'all' && member.teamId !== filters.teamId) continue;
    if (filters.ownerMemberId !== 'all' && member.id !== filters.ownerMemberId) continue;
    rowsByMember.set(member.id, {
      memberId: member.id,
      memberName: member.displayName,
      teamId: member.teamId,
      teamName: teamsById.get(member.teamId)?.name ?? '团队未配置',
      countedGmvCents: 0,
      countedReportCount: 0,
      pendingReviewCount: 0,
      returnedCount: 0,
      reconciliationRequiredCount: 0,
      reconciliationRequiredCents: 0,
      replacedByOrdersCount: 0,
    });
  }

  let countedManualCents = 0;
  let countedCount = 0;
  let pendingReviewCount = 0;
  let returnedCount = 0;
  let reconciliationRequiredCount = 0;
  let reconciliationRequiredCents = 0;
  let overlappingOrderCount = 0;
  let hasUnquantifiedOverlap = false;
  let replacedByOrdersCount = 0;
  for (const report of reports) {
    const member = rowsByMember.get(report.ownerMemberId);
    if (report.status === 'pending_review') {
      pendingReviewCount += 1;
      if (member) member.pendingReviewCount += 1;
    }
    if (report.status === 'returned') {
      returnedCount += 1;
      if (member) member.returnedCount += 1;
    }
    if (report.accountingStatus === 'counted') {
      countedManualCents += report.gmvCents;
      countedCount += 1;
      if (member) {
        member.countedGmvCents += report.gmvCents;
        member.countedReportCount += 1;
      }
    }
    if (report.accountingStatus === 'reconciliation_required') {
      reconciliationRequiredCount += 1;
      reconciliationRequiredCents += report.gmvCents;
      if (report.overlappingOrderCount === null) hasUnquantifiedOverlap = true;
      else overlappingOrderCount += report.overlappingOrderCount;
      if (member) {
        member.reconciliationRequiredCount += 1;
        member.reconciliationRequiredCents += report.gmvCents;
      }
    }
    if (report.accountingStatus === 'replaced_by_orders') {
      replacedByOrdersCount += 1;
      if (member) member.replacedByOrdersCount += 1;
    }
  }

  return {
    reports,
    memberRows: [...rowsByMember.values()].sort((left, right) => left.teamName.localeCompare(right.teamName, 'zh-CN') || left.memberName.localeCompare(right.memberName, 'zh-CN')),
    countedManualCents,
    countedCount,
    pendingReviewCount,
    returnedCount,
    reconciliationRequiredCount,
    reconciliationRequiredCents,
    overlappingOrderCount: hasUnquantifiedOverlap ? null : overlappingOrderCount,
    hasUnquantifiedOverlap,
    replacedByOrdersCount,
  };
}

function validShanghaiDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  return calendarDate.getUTCFullYear() === year && calendarDate.getUTCMonth() === month - 1 && calendarDate.getUTCDate() === day;
}

function nextCalendarDate(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

/** Converts inclusive date controls to the report's [start, end) Shanghai interval. */
export function shortVideoPeriodBounds(startDate: string, inclusiveEndDate: string) {
  if (!validShanghaiDate(startDate) || !validShanghaiDate(inclusiveEndDate)) throw new Error('请输入有效的统计开始和结束日期。');
  if (startDate > inclusiveEndDate) throw new Error('统计结束日期不能早于开始日期。');
  if (startDate.slice(0, 7) !== inclusiveEndDate.slice(0, 7)) throw new Error('短视频统计周期不能跨月，请按月分段填报。');
  const endExclusiveDate = nextCalendarDate(inclusiveEndDate);
  return {
    periodStartAt: new Date(`${startDate}T00:00:00+08:00`).toISOString(),
    periodEndAt: new Date(`${endExclusiveDate}T00:00:00+08:00`).toISOString(),
    creditedOn: inclusiveEndDate,
  };
}

/** Parses a yuan input without floating point rounding. */
export function parseYuanToCents(value: string): number | null {
  const cleaned = value.trim();
  if (!/^\d+(?:\.\d{0,2})?$/.test(cleaned)) return null;
  const [yuan, fraction = ''] = cleaned.split('.');
  const cents = Number(yuan) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}
