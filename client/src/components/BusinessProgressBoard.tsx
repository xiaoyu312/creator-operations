import { useMemo, useState } from 'react';
import { CalendarDays, ChevronDown, CircleHelp, Clock3, Search, UsersRound } from 'lucide-react';
import type {
  BusinessProgressActionCode,
  BusinessProgressCooperationWorkItem,
  BusinessProgressCreator,
  BusinessProgressNextAction,
  BusinessProgressOwner,
  BusinessProgressOwnerCreatorLink,
  BusinessProgressSalesEntry,
  BusinessProgressWorkspace,
} from '@shared/business-progress';
import type { Capability, Platform } from '@shared/types';
import { EmptyState, formatDate, formatDateTime, formatMoney, StatusPill, statusLabel } from './workbench';
import { platformLabel } from '../lib/platform-presentation';
import './business-progress.css';

type ProgressFilter = 'all' | 'actionable' | 'overdue' | 'unregistered';
type DateRange = { from: string; to: string };
type OwnerCreatorLink = BusinessProgressOwnerCreatorLink | { creatorKey: string; relation: 'unassigned'; workItemKeys: string[] };
type OwnerGroup = {
  key: string;
  ownerKey: string | null;
  name: string;
  active: boolean | null;
  kind: 'work_owner' | 'sales_only' | 'report_only' | 'unassigned';
  creators: BusinessProgressCreator[];
  creatorLinks: OwnerCreatorLink[];
};
type SalesRollup = {
  paidCount: number;
  paidKnownCents: number;
  paidUnknownAmountCount: number;
  paidUnknownDateCount: number;
  refundCount: number;
  refundKnownNetCents: number;
  refundUnknownAmountCount: number;
  refundUnknownDateCount: number;
  manualCount: number;
  manualCountedCount: number;
  manualCountedCents: number;
  manualUnreviewedCount: number;
  manualReturnedCount: number;
  manualReconciliationRequiredCount: number;
  replacedByOrdersCount: number;
};
type OwnerProgressMetrics = {
  creatorCount: number;
  workItemCount: number;
  processGapCount: number;
  overdueScheduleCount: number;
  overdueOwnerTaskCount: number;
  overdueRelatedTaskCount: number;
} | null;
type SalesQualityCounts = {
  duplicateConflictCount: number;
  unattributedPaidOrderLineCount: number;
  unlinkedCreatorCount: number;
  unassignedOwnerCount: number;
  missingAmountCount: number;
  missingDateCount: number;
};

const ALL_OWNERS = '__all__';
const UNASSIGNED_OWNER = '__unassigned__';
const PLATFORMS: Platform[] = ['douyin', 'channels', 'xiaohongshu', 'kuaishou'];
const capabilityLabels: Record<Capability, string> = {
  'sample.approve': '样品审核',
  'sample.fulfill': '样品发货/签收',
  'cooperation.approve': '合作/交付审核',
  'import.manage': '订单导入/来源核对',
  'audit.read': '审计',
  'export.run': '导出',
};

const actionLabels: Record<BusinessProgressActionCode, string> = {
  log_followup: '登记跟进',
  review_paused_creator: '复核暂停达人',
  submit_cooperation: '提交合作单',
  review_cooperation: '审核合作单',
  submit_sample_request: '提交寄样申请',
  create_sample_request: '补建寄样申请',
  approve_sample_request: '审核寄样申请',
  ship_samples: '寄出样品',
  confirm_sample_receipt: '确认签收',
  create_delivery: '创建交付任务',
  schedule_live: '登记直播排期',
  confirm_live_status: '核实排期状态',
  record_live_completion: '登记场次完成',
  submit_live_delivery: '提交直播交付',
  submit_short_video_delivery: '提交短视频交付',
  review_delivery: '验收交付',
  reconcile_sales: '核对销售归属',
  inspect_record: '核查资料',
  none: '暂无下一步',
};

const sampleProgressLabels: Record<string, string> = {
  not_required: '无需寄样', waived: '已免寄', awaiting_request: '待建申请', incomplete_data: '资料不完整',
  pending_approval: '待审核', pending_shipment: '待发货', partially_shipped: '部分发货', shipped: '已发货',
  partially_received: '部分签收', received: '已签收', rejected: '已驳回', closed: '已关闭',
};

const deliveryTypeLabels: Record<string, string> = { live: '直播', short_video: '短视频', other: '其他' };
const accountingLabels: Record<string, string> = {
  unreviewed: '待核对', returned: '已退回', counted: '已计入',
  reconciliation_required: '待对账', replaced_by_orders: '已由订单替代',
};
const ownerBasisLabels: Record<BusinessProgressSalesEntry['ownerBasis'], string> = {
  paid_at_snapshot: '支付时归属',
  correction: '人工更正归属',
  report_owner: '填报人',
  unassigned: '未归属销售',
  unknown: '归属待核实',
  not_applicable: '不适用',
};

function currentMonthRange(observedOn: string): DateRange {
  const month = /^\d{4}-\d{2}/u.exec(observedOn)?.[0] ?? '';
  return { from: month ? `${month}-01` : '', to: observedOn };
}

function uniqueCreators(creators: readonly BusinessProgressCreator[]) {
  const byKey = new Map<string, BusinessProgressCreator>();
  for (const creator of creators) byKey.set(creator.key, creator);
  return [...byKey.values()];
}

function getOwnerGroups(snapshot: BusinessProgressWorkspace): OwnerGroup[] {
  const creatorsByKey = new Map(snapshot.creatorRelations.map((creator) => [creator.key, creator]));
  const groups: OwnerGroup[] = snapshot.owners.map((owner: BusinessProgressOwner) => ({
    key: owner.key,
    ownerKey: owner.key,
    name: owner.displayName,
    active: owner.active,
    kind: owner.kind,
    creators: uniqueCreators(owner.creatorLinks.flatMap((link) => {
      const creator = creatorsByKey.get(link.creatorKey);
      return creator ? [creator] : [];
    })),
    creatorLinks: owner.creatorLinks,
  }));
  const hasUnassignedSales = snapshot.salesEntries.some((entry) => entry.ownerKey === null);
  if (snapshot.unassignedCreatorKeys.length || hasUnassignedSales) {
    const creatorLinks: OwnerCreatorLink[] = snapshot.unassignedCreatorKeys.map((creatorKey) => ({
      creatorKey,
      relation: 'unassigned',
      workItemKeys: [],
    }));
    groups.push({
      key: UNASSIGNED_OWNER,
      ownerKey: null,
      name: '未归属商务',
      active: null,
      kind: 'unassigned',
      creators: uniqueCreators(creatorLinks.flatMap((link) => {
        const creator = creatorsByKey.get(link.creatorKey);
        return creator ? [creator] : [];
      })),
      creatorLinks,
    });
  }
  return groups;
}

function normalizeQuery(value: string) {
  return value.trim().toLocaleLowerCase('zh-CN');
}

function containsQuery(query: string, ...values: Array<string | null | undefined>) {
  if (!query) return true;
  return values.some((value) => value?.toLocaleLowerCase('zh-CN').includes(query));
}

function actionStateLabel(action: BusinessProgressNextAction) {
  if (action.state === 'task') return '已登记任务';
  if (action.state === 'suggested') return '建议下一步';
  if (action.state === 'unregistered') return '下一步未登记';
  return '无待办';
}

function actionDueIsOverdue(action: BusinessProgressNextAction, observedAt: string) {
  if (action.state !== 'task' || !action.dueAt) return false;
  const dueAt = Date.parse(action.dueAt);
  const observed = Date.parse(observedAt);
  return Number.isFinite(dueAt) && Number.isFinite(observed) && dueAt < observed;
}

function actionMatchesFilter(action: BusinessProgressNextAction, filter: ProgressFilter, observedAt: string) {
  if (filter === 'all') return true;
  if (filter === 'actionable') return action.state !== 'none';
  if (filter === 'overdue') return actionDueIsOverdue(action, observedAt);
  return action.state === 'unregistered';
}

function workItemMatchesFilter(workItem: BusinessProgressCooperationWorkItem, filter: ProgressFilter, observedAt: string) {
  if (filter === 'all') return true;
  if (filter === 'actionable') return workItem.nextAction.state !== 'none';
  if (filter === 'overdue') return workItem.scheduleProgress.overdueCount > 0 || actionDueIsOverdue(workItem.nextAction, observedAt);
  return workItem.nextAction.state === 'unregistered';
}

function workItemMatchesPlatform(workItem: BusinessProgressCooperationWorkItem, platform: Platform | 'all') {
  return platform === 'all' || workItem.platforms.includes(platform);
}

function hasCurrentRelation(creator: BusinessProgressCreator, group: OwnerGroup) {
  return creator.currentOwnerKey === group.ownerKey;
}

function workItemsForGroup(creator: BusinessProgressCreator, group: OwnerGroup) {
  if (hasCurrentRelation(creator, group)) return creator.workItems;
  const cooperationWorkItemKeys = new Set(group.creatorLinks
    .filter((link) => link.creatorKey === creator.key && link.relation === 'cooperation')
    .flatMap((link) => link.workItemKeys));
  return creator.workItems.filter((workItem) => cooperationWorkItemKeys.has(workItem.key));
}

function creatorMatchesGroupFilter(creator: BusinessProgressCreator, group: OwnerGroup, filter: ProgressFilter, observedAt: string) {
  if (filter === 'all') return true;
  const currentRelation = hasCurrentRelation(creator, group);
  return (currentRelation && actionMatchesFilter(creator.nextAction, filter, observedAt))
    || workItemsForGroup(creator, group).some((workItem) => workItemMatchesFilter(workItem, filter, observedAt))
    || (currentRelation && creator.directSamples.some((sample) => actionMatchesFilter(sample.nextAction, filter, observedAt)));
}

function visibleGroupWorkItems(creator: BusinessProgressCreator, group: OwnerGroup, platform: Platform | 'all', filter: ProgressFilter, observedAt: string) {
  return workItemsForGroup(creator, group).filter((workItem) => workItemMatchesPlatform(workItem, platform)
    && workItemMatchesFilter(workItem, filter, observedAt));
}

function visibleDirectSamples(creator: BusinessProgressCreator, platform: Platform | 'all', filter: ProgressFilter, observedAt: string) {
  return creator.directSamples.filter((sample) => (platform === 'all' || sample.platforms.includes(platform))
    && actionMatchesFilter(sample.nextAction, filter, observedAt));
}

function visibleGroupDirectSamples(creator: BusinessProgressCreator, group: OwnerGroup, platform: Platform | 'all', filter: ProgressFilter, observedAt: string) {
  return hasCurrentRelation(creator, group) ? visibleDirectSamples(creator, platform, filter, observedAt) : [];
}

function creatorMatchesGroupPlatform(creator: BusinessProgressCreator, group: OwnerGroup, platform: Platform | 'all') {
  if (platform === 'all') return true;
  const currentRelation = hasCurrentRelation(creator, group);
  return (currentRelation && creator.platforms.includes(platform))
    || workItemsForGroup(creator, group).some((workItem) => workItemMatchesPlatform(workItem, platform))
    || (currentRelation && creator.directSamples.some((sample) => sample.platforms.includes(platform)));
}

function creatorSearchValues(creator: BusinessProgressCreator, group?: OwnerGroup) {
  const workItems = group ? workItemsForGroup(creator, group) : creator.workItems;
  const currentRelation = group ? hasCurrentRelation(creator, group) : true;
  return [
    creator.name,
    ...workItems.map((workItem) => workItem.title),
    ...workItems.flatMap((workItem) => workItem.platforms.map(platformLabel)),
    ...(currentRelation ? creator.platforms.map(platformLabel) : []),
    ...(currentRelation ? [statusLabel(creator.crmStage), actionLabels[creator.nextAction.code]] : []),
  ];
}

function filterGroupCreators(
  group: OwnerGroup,
  query: string,
  platform: Platform | 'all',
  progressFilter: ProgressFilter,
  observedAt: string,
) {
  const ownerMatches = containsQuery(query, group.name);
  return group.creators.filter((creator) => creatorMatchesGroupPlatform(creator, group, platform)
    && creatorMatchesGroupFilter(creator, group, progressFilter, observedAt)
    && (ownerMatches || containsQuery(query, ...creatorSearchValues(creator, group))));
}

function entryDateMatches(entry: BusinessProgressSalesEntry, range: DateRange) {
  if (!range.from && !range.to) return true;
  if (!entry.date) return false;
  return (!range.from || entry.date >= range.from) && (!range.to || entry.date <= range.to);
}

function sumKnown(entries: readonly BusinessProgressSalesEntry[]) {
  return entries.reduce((sum, entry) => sum + (entry.amountCents ?? 0), 0);
}

function salesRollup(entries: readonly BusinessProgressSalesEntry[], paidUnknownDateCount = 0, refundUnknownDateCount = 0): SalesRollup {
  const paid = entries.filter((entry) => entry.kind === 'order' && entry.status === 'paid');
  const refunds = entries.filter((entry) => entry.kind === 'refund' && entry.status === 'succeeded');
  const manual = entries.filter((entry) => entry.kind === 'manual');
  const refundKnownNetCents = refunds.reduce((sum, entry) => {
    const amount = entry.amountCents ?? 0;
    return sum + (entry.refundDirection === 'reversal' ? amount : -amount);
  }, 0);
  return {
    paidCount: paid.length,
    paidKnownCents: sumKnown(paid),
    paidUnknownAmountCount: paid.filter((entry) => entry.amountCents === null).length,
    paidUnknownDateCount,
    refundCount: refunds.length,
    refundKnownNetCents,
    refundUnknownAmountCount: refunds.filter((entry) => entry.amountCents === null).length,
    refundUnknownDateCount,
    manualCount: manual.length,
    manualCountedCount: manual.filter((entry) => entry.accountingStatus === 'counted').length,
    manualCountedCents: sumKnown(manual.filter((entry) => entry.accountingStatus === 'counted')),
    manualUnreviewedCount: manual.filter((entry) => entry.accountingStatus === 'unreviewed').length,
    manualReturnedCount: manual.filter((entry) => entry.accountingStatus === 'returned').length,
    manualReconciliationRequiredCount: manual.filter((entry) => entry.accountingStatus === 'reconciliation_required').length,
    replacedByOrdersCount: manual.filter((entry) => entry.accountingStatus === 'replaced_by_orders').length,
  };
}

function moneyOrUnknown(value: number, unknownCount: number) {
  return <>{formatMoney(value)}{unknownCount > 0 && <small className="bp-secondary">另有 {unknownCount} 行金额待补</small>}</>;
}

function ownerLabel(ownerKey: string | null, ownerNameByKey: ReadonlyMap<string, string>) {
  if (!ownerKey) return '未归属或不可解析';
  return ownerNameByKey.get(ownerKey) ?? '负责人待确认';
}

function hasProcessGap(workItem: BusinessProgressCooperationWorkItem) {
  return workItem.nextAction.state === 'unregistered'
    || workItem.status === 'rejected'
    || workItem.sampleProgress.state === 'incomplete_data'
    || workItem.sampleProgress.state === 'rejected'
    || workItem.deliveryProgress.byType.some((item) => item.returnedCount > 0);
}

function ownerProgressMetrics(
  group: OwnerGroup,
  creators: readonly BusinessProgressCreator[],
  platform: Platform | 'all',
  progressFilter: ProgressFilter,
  observedAt: string,
): OwnerProgressMetrics {
  if (group.kind === 'sales_only' || group.kind === 'report_only') return null;
  const currentCreators = creators.filter((creator) => creator.currentOwnerKey === group.ownerKey);
  const workItems = new Map<string, BusinessProgressCooperationWorkItem>();
  for (const creator of creators) {
    for (const workItem of creator.workItems) {
      if (workItem.cooperationOwnerKey !== group.ownerKey
        || !workItemMatchesPlatform(workItem, platform)
        || !workItemMatchesFilter(workItem, progressFilter, observedAt)) continue;
      workItems.set(workItem.key, workItem);
    }
  }
  let processGapCount = [...workItems.values()].filter(hasProcessGap).length;
  let overdueOwnerTaskCount = 0;
  let overdueRelatedTaskCount = 0;
  const countOverdueAction = (action: BusinessProgressNextAction) => {
    if (!actionDueIsOverdue(action, observedAt)) return;
    if (group.ownerKey !== null && action.ownerKey === group.ownerKey) overdueOwnerTaskCount += 1;
    else overdueRelatedTaskCount += 1;
  };
  for (const workItem of workItems.values()) countOverdueAction(workItem.nextAction);
  for (const creator of currentCreators) {
    if (creator.nextAction.state === 'unregistered') processGapCount += 1;
    countOverdueAction(creator.nextAction);
    const directSamples = visibleDirectSamples(creator, platform, progressFilter, observedAt);
    processGapCount += directSamples.filter((sample) => sample.nextAction.state === 'unregistered').length;
    for (const sample of directSamples) countOverdueAction(sample.nextAction);
  }
  return {
    creatorCount: currentCreators.length,
    workItemCount: workItems.size,
    processGapCount,
    overdueScheduleCount: [...workItems.values()].reduce((sum, workItem) => sum + workItem.scheduleProgress.overdueCount, 0),
    overdueOwnerTaskCount,
    overdueRelatedTaskCount,
  };
}

function creatorSalesEntries(
  creator: BusinessProgressCreator,
  entries: readonly BusinessProgressSalesEntry[],
) {
  return entries.filter((entry) => entry.creatorKey === creator.key
    && (entry.kind === 'manual' || (entry.kind === 'order' && entry.status === 'paid') || (entry.kind === 'refund' && entry.status === 'succeeded')));
}

function salesOwnerCopy(ownerBasis: BusinessProgressSalesEntry['ownerBasis'] | null | undefined, ownerKey: string | null, ownerNameByKey: ReadonlyMap<string, string>) {
  const safeOwnerBasis = ownerBasis && ownerBasis in ownerBasisLabels ? ownerBasis : 'unknown';
  if (safeOwnerBasis === 'unassigned') return '未归属销售';
  if (safeOwnerBasis === 'unknown') return '销售归属待核实';
  if (safeOwnerBasis === 'not_applicable') return '未支付订单';
  return `${ownerBasisLabels[safeOwnerBasis]} · ${ownerLabel(ownerKey, ownerNameByKey)}`;
}

function actionCopy(action: BusinessProgressNextAction, ownerNameByKey: ReadonlyMap<string, string>) {
  const capabilityLabel = action.requiredCapability ? capabilityLabels[action.requiredCapability] : '';
  return {
    title: actionLabels[action.code] ?? '核查资料',
    state: actionStateLabel(action),
    responsibility: action.ownerKey
      ? `${capabilityLabel ? `${capabilityLabel} · ` : ''}任务负责人 ${ownerLabel(action.ownerKey, ownerNameByKey)}`
      : capabilityLabel ? `岗位待处理：${capabilityLabel}` : '',
    dueAt: action.dueAt,
  };
}

function NextAction({ action, ownerNameByKey }: { action: BusinessProgressNextAction; ownerNameByKey: ReadonlyMap<string, string> }) {
  const copy = actionCopy(action, ownerNameByKey);
  return <div className={`bp-next-action bp-next-action-${action.state}`}>
    <span className="bp-action-state">{copy.state}</span>
    <strong>{copy.title}</strong>
    {(copy.responsibility || copy.dueAt) && <small>{[copy.responsibility, copy.dueAt ? `截止 ${formatDateTime(copy.dueAt)}` : ''].filter(Boolean).join(' · ')}</small>}
  </div>;
}

function ProgressPlatforms({ platforms }: { platforms: Platform[] }) {
  if (!platforms.length) return <span className="bp-muted">平台未标注</span>;
  return <span className="bp-platform-list">{platforms.map((platform) => <span className="bp-platform-tag" key={platform}>{platformLabel(platform)}</span>)}</span>;
}

function sampleProgressSummary(workItem: BusinessProgressCooperationWorkItem) {
  const progress = workItem.sampleProgress;
  const quantities = progress.requiredQuantity === null
    ? '数量待补'
    : `已寄 ${progress.shippedQuantity ?? '—'} / ${progress.requiredQuantity}，已签收 ${progress.receivedQuantity ?? '—'}`;
  return `${sampleProgressLabels[progress.state] ?? statusLabel(progress.state)} · 申请 ${progress.presentRequestCount}/${progress.requiredRequestCount} · ${quantities}`;
}

function deliverySummary(workItem: BusinessProgressCooperationWorkItem) {
  if (!workItem.deliveryProgress.byType.length) return '暂无交付要求记录';
  return workItem.deliveryProgress.byType.map((item) => {
    const submitted = item.approvedCount + item.pendingReviewCount + item.returnedCount;
    return `${deliveryTypeLabels[item.deliveryType] ?? '其他'} 已提交 ${submitted}/${item.requiredCount} · 内部验收通过 ${item.approvedCount}`
      + (item.pendingSubmissionCount ? ` · 待提交 ${item.pendingSubmissionCount}` : '')
      + (item.pendingReviewCount ? ` · 待验收 ${item.pendingReviewCount}` : '')
      + (item.returnedCount ? ` · 待修改 ${item.returnedCount}` : '');
  }).join('；');
}

function WorkItemDetails({
  workItem,
  ownerNameByKey,
}: {
  workItem: BusinessProgressCooperationWorkItem;
  ownerNameByKey: ReadonlyMap<string, string>;
}) {
  const schedule = workItem.scheduleProgress;
  const scheduleSummary = schedule.next
    ? `${formatDateTime(schedule.next.plannedStartAt)}–${formatDateTime(schedule.next.plannedEndAt)} · ${schedule.next.timing === 'overdue' ? '已逾期' : schedule.next.timing === 'in_window' ? '进行中' : schedule.next.timing === 'upcoming' ? '未开始' : '时间待核实'}`
    : '当前没有未关闭排期';
  const productNames = workItem.products.map((product) => product.name);
  return <details className="bp-work-item">
    <summary>
      <span className="bp-work-item-main"><strong>{workItem.title || '未命名合作单'}</strong><StatusPill value={workItem.status} /></span>
      <span className="bp-work-item-meta"><span>{ownerLabel(workItem.cooperationOwnerKey, ownerNameByKey)}</span><ProgressPlatforms platforms={workItem.platforms} /></span>
      <ChevronDown size={16} aria-hidden="true" className="bp-chevron" />
    </summary>
    <div className="bp-work-item-body">
      <div className="bp-work-item-grid">
        <div><span className="bp-detail-label">合作负责人</span><strong>{ownerLabel(workItem.cooperationOwnerKey, ownerNameByKey)}</strong></div>
        <div><span className="bp-detail-label">合作状态</span><StatusPill value={workItem.status} /></div>
        <div><span className="bp-detail-label">寄样</span><strong>{sampleProgressSummary(workItem)}</strong></div>
        <div><span className="bp-detail-label">下一场排期</span><strong>{scheduleSummary}</strong>{schedule.overdueCount > 0 && <small className="bp-danger-copy">逾期未完成排期 {schedule.overdueCount} 场</small>}</div>
        <div><span className="bp-detail-label">交付进度</span><strong>{deliverySummary(workItem)}</strong></div>
        <div><span className="bp-detail-label">合作商品</span><strong>{productNames.length ? productNames.join('、') : '未关联商品'}</strong>{workItem.unresolvedProductLineCount > 0 && <small>另有 {workItem.unresolvedProductLineCount} 项商品信息待核对</small>}</div>
        <div><span className="bp-detail-label">最近更新</span><strong>{formatDateTime(workItem.updatedAt)}</strong></div>
        <div><span className="bp-detail-label">已登记场次</span><strong>内部完成登记 {schedule.completionRecordedCount} 场</strong><small>内部记录不等于平台核验</small></div>
      </div>
      {schedule.latestRecordedCompletion && <p className="bp-record-note">最近一次内部完成登记：{formatDateTime(schedule.latestRecordedCompletion.actualStartAt)} 至 {formatDateTime(schedule.latestRecordedCompletion.actualEndAt)}。</p>}
      <NextAction action={workItem.nextAction} ownerNameByKey={ownerNameByKey} />
      <p className="bp-record-note">销售按达人和支付时负责人归属汇总，不拆分到这张合作单。</p>
    </div>
  </details>;
}

function DirectSamples({ samples, ownerNameByKey }: { samples: BusinessProgressCreator['directSamples']; ownerNameByKey: ReadonlyMap<string, string> }) {
  if (!samples.length) return null;
  return <details className="bp-direct-samples">
    <summary><strong>未挂合作单的寄样</strong><span>{samples.length} 条</span><ChevronDown size={15} aria-hidden="true" className="bp-chevron" /></summary>
    <div className="bp-direct-sample-list">{samples.map((sample) => <div className="bp-direct-sample" key={sample.key}>
      <div><StatusPill value={sample.status} /><ProgressPlatforms platforms={sample.platforms} /></div>
      <span>申请更新于 {formatDateTime(sample.updatedAt)}</span>
      <NextAction action={sample.nextAction} ownerNameByKey={ownerNameByKey} />
    </div>)}</div>
  </details>;
}

function CreatorSales({
  creator,
  entries,
  ownerNameByKey,
}: {
  creator: BusinessProgressCreator;
  entries: readonly BusinessProgressSalesEntry[];
  ownerNameByKey: ReadonlyMap<string, string>;
}) {
  const rows = creatorSalesEntries(creator, entries);
  if (!rows.length) return <p className="bp-sales-empty">当前统计期未读取到匹配的销售明细；这不代表平台实际成交为零。</p>;
  const owners = new Map<string, { kind: 'orders' | 'manual'; ownerKey: string | null; ownerBasis: BusinessProgressSalesEntry['ownerBasis'] | null | undefined; entries: BusinessProgressSalesEntry[] }>();
  for (const entry of rows) {
    const kind = entry.kind === 'manual' ? 'manual' : 'orders';
    const ownerBasis = entry.ownerBasis ?? 'unknown';
    const key = `${kind}:${ownerBasis}:${entry.ownerKey ?? UNASSIGNED_OWNER}`;
    const current = owners.get(key) ?? { kind, ownerKey: entry.ownerKey, ownerBasis, entries: [] };
    current.entries.push(entry);
    owners.set(key, current);
  }
  return <div className="bp-creator-sales">
    <div className="bp-detail-heading"><strong>达人销售记录</strong><span>统计期内 · 按支付时快照、人工更正或填报人归属；同一达人可能在多个负责人视图出现</span></div>
    {[...owners.entries()].map(([key, group]) => {
      const rollup = salesRollup(group.entries);
      return <div className="bp-sales-owner-row" key={key}>
        <strong>{salesOwnerCopy(group.ownerBasis, group.ownerKey, ownerNameByKey)}</strong>
        {group.kind === 'orders' && <span>订单明细 {rollup.paidCount} 行 · 已知支付 {moneyOrUnknown(rollup.paidKnownCents, rollup.paidUnknownAmountCount)}</span>}
        {rollup.refundCount > 0 && <span>退款/冲正 {rollup.refundCount} 条 · 已知净额 {formatMoney(rollup.refundKnownNetCents)}{rollup.refundUnknownAmountCount > 0 ? ` · ${rollup.refundUnknownAmountCount} 条金额待补` : ''}</span>}
        {rollup.manualCount > 0 && <>
          <span>手工填报 {rollup.manualCount} 条 · 已计入 {rollup.manualCountedCount} 条 / {formatMoney(rollup.manualCountedCents)} · 待核对 {rollup.manualUnreviewedCount} · 已退回 {rollup.manualReturnedCount} · 待对账 {rollup.manualReconciliationRequiredCount} · 已由订单替代 {rollup.replacedByOrdersCount}</span>
          <span className="bp-manual-entry-list">{group.entries.map((entry) => <span className="bp-manual-entry" key={entry.sourceKey}>
            <StatusPill value={entry.accountingStatus ?? entry.status} label={accountingLabels[entry.accountingStatus ?? ''] ?? statusLabel(entry.accountingStatus ?? entry.status)} tone={entry.accountingStatus === 'counted' ? 'green' : entry.accountingStatus === 'replaced_by_orders' ? 'blue' : entry.accountingStatus === 'returned' ? 'red' : 'orange'} />
            <span>{formatDate(entry.date)} · {entry.amountCents === null ? '金额暂不计入' : formatMoney(entry.amountCents)}</span>
          </span>)}</span>
        </>}
      </div>;
    })}
  </div>;
}

function CreatorProgress({
  creator,
  groupName,
  visibleItems,
  visibleSamples,
  salesEntries,
  ownerNameByKey,
}: {
  creator: BusinessProgressCreator;
  groupName: string;
  visibleItems: BusinessProgressCooperationWorkItem[];
  visibleSamples: BusinessProgressCreator['directSamples'];
  salesEntries: readonly BusinessProgressSalesEntry[];
  ownerNameByKey: ReadonlyMap<string, string>;
}) {
  return <article className="bp-creator-row">
    <header className="bp-creator-header">
      <div className="bp-creator-identity">
        <span className="bp-creator-avatar" aria-hidden="true"><UsersRound size={17} /></span>
        <div><h4>{creator.name}</h4><p><StatusPill value={creator.crmStage} /> <span>阶段更新于 {formatDateTime(creator.crmStageAt)}</span></p></div>
      </div>
      <div className="bp-creator-platforms"><ProgressPlatforms platforms={creator.platforms} /></div>
    </header>
    <div className="bp-creator-facts">
      <div><span className="bp-detail-label">当前 CRM 负责人</span><strong>{ownerLabel(creator.currentOwnerKey, ownerNameByKey)}</strong></div>
      <div><span className="bp-detail-label">所属商务视图</span><strong>{groupName}</strong></div>
      <div><span className="bp-detail-label">最近跟进</span><strong>{formatDateTime(creator.lastFollowupAt)}</strong></div>
      <div className="bp-creator-action"><span className="bp-detail-label">达人下一步</span><NextAction action={creator.nextAction} ownerNameByKey={ownerNameByKey} /></div>
    </div>
    <section className="bp-creator-work-items" aria-label={`${creator.name} 合作进度`}>
      <div className="bp-detail-heading"><strong>合作进度</strong><span>{visibleItems.length} 张合作单</span></div>
      {visibleItems.length ? visibleItems.map((workItem) => <WorkItemDetails key={workItem.key} workItem={workItem} ownerNameByKey={ownerNameByKey} />)
        : <p className="bp-inline-empty">当前筛选下没有匹配的合作单。</p>}
      <DirectSamples samples={visibleSamples} ownerNameByKey={ownerNameByKey} />
      <CreatorSales creator={creator} entries={salesEntries} ownerNameByKey={ownerNameByKey} />
    </section>
  </article>;
}

function OwnerSalesSummary({ rollup, groupKind }: { rollup: SalesRollup; groupKind: OwnerGroup['kind'] }) {
  const showOrderMetrics = groupKind !== 'report_only';
  return <div className="bp-owner-sales">
    {showOrderMetrics && <>
      <strong>{formatMoney(rollup.paidKnownCents)}</strong>
      <small>已知支付金额 · {rollup.paidCount} 行订单明细</small>
      {rollup.paidUnknownAmountCount > 0 && <small className="bp-warning-copy">另有 {rollup.paidUnknownAmountCount} 行金额待补</small>}
      {rollup.paidUnknownDateCount > 0 && <small>支付日期未知 {rollup.paidUnknownDateCount} 行，无法判断是否属于统计期</small>}
      {rollup.refundCount > 0 && <small>退款/冲正 {formatMoney(rollup.refundKnownNetCents)}（记录口径）</small>}
      {rollup.refundUnknownDateCount > 0 && <small>退款日期未知 {rollup.refundUnknownDateCount} 条，无法判断是否属于统计期</small>}
    </>}
    {rollup.manualCount > 0 && <small>手工填报 {rollup.manualCount} 条 · 已计入 {rollup.manualCountedCount} 条 / {formatMoney(rollup.manualCountedCents)}</small>}
    {rollup.manualUnreviewedCount > 0 && <small className="bp-warning-copy">待核对 {rollup.manualUnreviewedCount} 条</small>}
    {rollup.manualReturnedCount > 0 && <small className="bp-warning-copy">已退回 {rollup.manualReturnedCount} 条</small>}
    {rollup.manualReconciliationRequiredCount > 0 && <small className="bp-warning-copy">待对账 {rollup.manualReconciliationRequiredCount} 条</small>}
    {rollup.replacedByOrdersCount > 0 && <small>已由订单替代 {rollup.replacedByOrdersCount} 条</small>}
  </div>;
}

function OwnerRowButton({ group, selected, onSelect }: { group: OwnerGroup; selected: boolean; onSelect: () => void }) {
  return <button type="button" className="bp-owner-select" aria-pressed={selected} onClick={onSelect}>
    <strong>{group.name}{group.active === false ? '（已停用）' : ''}</strong>
    <small>{group.kind === 'sales_only' ? '历史销售归属，无当前推进事项' : group.kind === 'report_only' ? '仅有手工填报，无当前商务推进事项' : group.kind === 'unassigned' ? 'CRM 未归属达人或未归属销售记录' : '关联 CRM 当前负责人或合作单的达人'}</small>
  </button>;
}

function formatCount(count: number, suffix: string) {
  return `${count} ${suffix}`;
}

function salesQualityCounts(snapshot: BusinessProgressWorkspace, platform: Platform | 'all'): SalesQualityCounts {
  const relevantEntries = snapshot.salesEntries.filter((entry) => {
    if (platform !== 'all' && entry.platform !== platform) return false;
    if (entry.kind === 'manual') return true;
    if (entry.kind === 'order') return entry.status === 'paid' || entry.status === 'unknown';
    return entry.status === 'succeeded' || entry.status === 'unknown';
  });
  return {
    duplicateConflictCount: snapshot.unattributedSales.duplicateConflictCount,
    unattributedPaidOrderLineCount: snapshot.unattributedSales.paidOrderLineCount,
    unlinkedCreatorCount: relevantEntries.filter((entry) => entry.creatorKey === null).length,
    unassignedOwnerCount: relevantEntries.filter((entry) => entry.ownerKey === null).length,
    missingAmountCount: relevantEntries.filter((entry) => {
      const paidOrderMissing = entry.kind === 'order' && (entry.status === 'paid' || entry.status === 'unknown') && entry.amountCents === null;
      const refundMissing = entry.kind === 'refund' && (entry.status === 'succeeded' || entry.status === 'unknown') && entry.amountCents === null;
      const countedManualMissing = entry.kind === 'manual' && entry.accountingStatus === 'counted' && entry.amountCents === null;
      return paidOrderMissing || refundMissing || countedManualMissing;
    }).length,
    missingDateCount: relevantEntries.filter((entry) => {
      if (entry.kind === 'manual') return entry.date === null;
      return (entry.status === 'paid' || entry.status === 'succeeded' || entry.status === 'unknown') && entry.date === null;
    }).length,
  };
}

function SalesDataQuality({ snapshot, platform }: { snapshot: BusinessProgressWorkspace; platform: Platform | 'all' }) {
  const counts = salesQualityCounts(snapshot, platform);
  const checkedRows = snapshot.salesEntries.filter((entry) => (platform === 'all' || entry.platform === platform)
    && (entry.kind === 'manual' || entry.status === 'paid' || entry.status === 'succeeded' || entry.status === 'unknown')).length;
  return <section className="bp-quality-section" aria-labelledby="bp-quality-heading">
    <div className="bp-section-heading">
      <div><h3 id="bp-quality-heading">销售待确认数据</h3><p>覆盖 {platform === 'all' ? '全部平台' : platformLabel(platform)}、资料更新时间前的销售记录；不受销售统计期、负责人、搜索或进度状态筛选影响。</p></div>
      <span>{checkedRows} 条台账记录 · 日期不限</span>
    </div>
    <dl className="bp-quality-grid">
      <div><dt>重复键冲突</dt><dd>{counts.duplicateConflictCount}</dd><small>全平台 · 日期不限</small></div>
      <div><dt>未关联达人支付订单行</dt><dd>{counts.unattributedPaidOrderLineCount}</dd><small>全平台 · 日期不限</small></div>
      <div><dt>未关联达人销售记录</dt><dd>{counts.unlinkedCreatorCount}</dd><small>当前平台 · 日期不限 · 条记录</small></div>
      <div><dt>未归属负责人</dt><dd>{counts.unassignedOwnerCount}</dd><small>当前平台 · 日期不限 · 条记录</small></div>
      <div><dt>金额缺失</dt><dd>{counts.missingAmountCount}</dd><small>当前平台 · 日期不限 · 条记录</small></div>
      <div><dt>日期缺失</dt><dd>{counts.missingDateCount}</dd><small>当前平台 · 日期不限 · 条记录</small></div>
    </dl>
    <p className="bp-quality-note">重复键冲突为去重冲突键数，其余为销售记录数；同一记录可能同时出现在多个待确认项中，数量不能相加。金额缺失只统计支付订单、成功退款和已计入的手工填报，待核对填报不计为缺失。</p>
  </section>;
}

export default function BusinessProgressBoard({ snapshot }: { snapshot?: BusinessProgressWorkspace | null }) {
  const [ownerFilter, setOwnerFilter] = useState(ALL_OWNERS);
  const [platform, setPlatform] = useState<Platform | 'all'>('all');
  const [progressFilter, setProgressFilter] = useState<ProgressFilter>('all');
  const [search, setSearch] = useState('');
  const [dateRange, setDateRange] = useState<DateRange | null>(null);

  const ownerGroups = useMemo(() => snapshot ? getOwnerGroups(snapshot) : [], [snapshot]);
  const range = useMemo(() => dateRange ?? (snapshot ? currentMonthRange(snapshot.observedOn) : { from: '', to: '' }), [dateRange, snapshot]);
  const query = normalizeQuery(search);
  const ownerNameByKey = useMemo(() => new Map((snapshot?.ownerDirectory ?? []).map((owner) => [owner.key, owner.active ? owner.displayName : `${owner.displayName}（已停用）`] as const)), [snapshot?.ownerDirectory]);
  const allCreatorMap = useMemo(() => new Map((snapshot?.creatorRelations ?? []).map((creator) => [creator.key, creator])), [snapshot?.creatorRelations]);

  const filteredOwnerGroups = useMemo(() => ownerGroups.map((group) => ({
    group,
    creators: filterGroupCreators(group, query, platform, progressFilter, snapshot?.observedAt ?? ''),
  })), [ownerGroups, query, platform, progressFilter, snapshot?.observedAt]);

  const selectedGroup = ownerGroups.find((group) => group.key === ownerFilter) ?? null;
  const selectedCreatorRows = filteredOwnerGroups.find(({ group }) => group.key === ownerFilter)?.creators ?? [];
  const selectedCreatorKeys = new Set(selectedCreatorRows.map((creator) => creator.key));

  const entriesForGroup = (group: OwnerGroup, matchingCreators: readonly BusinessProgressCreator[], includeUnknownPaidDates = false) => {
    const matchingCreatorKeys = new Set(matchingCreators.map((creator) => creator.key));
    const ownerQueryMatches = containsQuery(query, group.name);
    return (snapshot?.salesEntries ?? []).filter((entry) => {
      if (entry.ownerKey !== group.ownerKey) return false;
      if (platform !== 'all' && entry.platform !== platform) return false;
      const missingDateForSales = (entry.kind === 'order' && entry.status === 'paid' || entry.kind === 'refund' && entry.status === 'succeeded') && !entry.date;
      if (!entryDateMatches(entry, range) && !(includeUnknownPaidDates && missingDateForSales)) return false;
      if (progressFilter !== 'all' && (!entry.creatorKey || !matchingCreatorKeys.has(entry.creatorKey))) return false;
      if (query && !ownerQueryMatches) {
        const creator = entry.creatorKey ? allCreatorMap.get(entry.creatorKey) : undefined;
        if (!creator || !containsQuery(query, ...creatorSearchValues(creator))) return false;
      }
      return true;
    });
  };

  const visibleRows = filteredOwnerGroups.filter(({ group }) => ownerFilter === ALL_OWNERS || group.key === ownerFilter);
  const ownerSalesByKey = new Map(visibleRows.map(({ group, creators }) => {
    const unknownDateEntries = entriesForGroup(group, creators, true).filter((entry) => !entry.date);
    const unknownPaidDateCount = unknownDateEntries.filter((entry) => entry.kind === 'order' && entry.status === 'paid').length;
    const unknownRefundDateCount = unknownDateEntries.filter((entry) => entry.kind === 'refund' && entry.status === 'succeeded').length;
    return [group.key, salesRollup(entriesForGroup(group, creators), unknownPaidDateCount, unknownRefundDateCount)] as const;
  }));
  const ownerProgressByKey = new Map(visibleRows.map(({ group, creators }) => [
    group.key,
    ownerProgressMetrics(group, creators, platform, progressFilter, snapshot?.observedAt ?? ''),
  ] as const));

  const selectedEntries = (snapshot?.salesEntries ?? []).filter((entry) => Boolean(entry.creatorKey)
    && selectedCreatorKeys.has(entry.creatorKey ?? '')
    && (platform === 'all' || entry.platform === platform)
    && entryDateMatches(entry, range));
  const dateRangeInvalid = Boolean(range.from && range.to && range.from > range.to);

  function resetFilters() {
    setOwnerFilter(ALL_OWNERS);
    setPlatform('all');
    setProgressFilter('all');
    setSearch('');
    setDateRange(null);
  }

  if (!snapshot) {
    return <section className="business-progress-board business-progress-empty"><EmptyState title="暂无进度资料" description="当前工作区没有可见的商务推进资料。" /></section>;
  }

  return <section className="business-progress-board">
    <header className="bp-heading">
      <div>
        <p className="bp-eyebrow">只读 · 当前进度不受销售统计期影响</p>
        <h2>商务推进</h2>
        <p>按负责人查看达人关系、合作单、寄样、排期与交付；支付订单和手工填报分别按各自归属核对。</p>
      </div>
      <div className="bp-observed-at"><Clock3 size={15} aria-hidden="true" /><span>资料更新于 {formatDateTime(snapshot.observedAt)}</span></div>
    </header>

    <div className="bp-filter-bar" aria-label="商务推进筛选">
      <label className="bp-filter bp-search-filter"><span>搜索</span><span className="bp-input-wrap"><Search size={15} aria-hidden="true" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索达人、合作单或负责人…" /></span></label>
      <label className="bp-filter"><span>负责人</span><select value={ownerFilter} onChange={(event) => setOwnerFilter(event.target.value)}><option value={ALL_OWNERS}>全部负责人</option>{ownerGroups.map((group) => <option value={group.key} key={group.key}>{group.name}{group.kind === 'sales_only' ? '（历史销售）' : group.kind === 'report_only' ? '（手工填报）' : ''}{group.active === false ? '（已停用）' : ''}</option>)}</select></label>
      <label className="bp-filter"><span>平台</span><select value={platform} onChange={(event) => setPlatform(event.target.value as Platform | 'all')}><option value="all">全部平台</option>{PLATFORMS.map((item) => <option value={item} key={item}>{platformLabel(item)}</option>)}</select></label>
      <label className="bp-filter"><span>进度状态</span><select value={progressFilter} onChange={(event) => setProgressFilter(event.target.value as ProgressFilter)}><option value="all">全部进度</option><option value="actionable">有下一步</option><option value="overdue">逾期</option><option value="unregistered">下一步未登记</option></select></label>
      <fieldset className="bp-filter bp-date-filter">
        <legend><CalendarDays size={14} aria-hidden="true" />销售统计期</legend>
        <label><span className="bp-sr-only">开始日期</span><input type="date" value={range.from} max={range.to || undefined} onChange={(event) => setDateRange({ ...range, from: event.target.value })} /></label>
        <span aria-hidden="true">至</span>
        <label><span className="bp-sr-only">结束日期</span><input type="date" value={range.to} min={range.from || undefined} onChange={(event) => setDateRange({ ...range, to: event.target.value })} /></label>
      </fieldset>
      <button type="button" className="bp-reset-button" onClick={resetFilters}>重置筛选</button>
    </div>

    <div className="bp-filter-note" role="note"><CircleHelp size={15} aria-hidden="true" /><span>日期只筛销售记录；进度始终显示当前状态。状态筛选按达人或合作单筛选关联销售，不把销售分摊给合作单。</span></div>
    {dateRangeInvalid && <p className="bp-date-error" role="alert">开始日期不能晚于结束日期。</p>}

    <section className="bp-owner-section" aria-labelledby="bp-owner-heading">
      <div className="bp-section-heading"><div><h3 id="bp-owner-heading">负责人总览</h3><p>在手达人按当前 CRM 负责人计数，合作按合作单负责人计数；历史销售归属单独列出，不计入在手达人和合作。</p></div><span>{formatCount(visibleRows.length, '个分组')}</span></div>
      {!visibleRows.length ? <EmptyState title="当前筛选下没有商务记录" description="调整平台、进度状态或搜索内容。" /> : <>
        <div className="bp-owner-table-wrap">
          <table className="bp-owner-table">
            <thead><tr><th>负责人 / 归属</th><th className="numeric">在手达人</th><th className="numeric">负责合作单</th><th>流程卡点 / 逾期事项</th><th>支付订单明细与填报</th></tr></thead>
            <tbody>{visibleRows.map(({ group, creators }) => {
              const sales = ownerSalesByKey.get(group.key) ?? salesRollup([]);
              const progress = ownerProgressByKey.get(group.key) ?? null;
              return <tr key={group.key} className={group.key === ownerFilter ? 'is-selected' : undefined}>
                <td><OwnerRowButton group={group} selected={group.key === ownerFilter} onSelect={() => setOwnerFilter(group.key)} /></td>
                <td className="numeric">{progress ? progress.creatorCount : '—'}</td>
                <td className="numeric">{progress ? progress.workItemCount : '—'}</td>
                <td>{progress ? <div className={`bp-progress-summary${progress.processGapCount ? ' is-attention' : ''}`}><strong>{progress.processGapCount} 项流程卡点</strong><small className={progress.overdueScheduleCount || progress.overdueOwnerTaskCount || progress.overdueRelatedTaskCount ? 'bp-danger-copy' : ''}>{progress.overdueScheduleCount} 场逾期排期 · 当前下一步逾期：本人 {progress.overdueOwnerTaskCount} 项、关联岗位/他人 {progress.overdueRelatedTaskCount} 项</small></div> : <span className="bp-muted">无当前推进事项</span>}</td>
                <td><OwnerSalesSummary rollup={sales} groupKind={group.kind} /></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
        <div className="bp-owner-cards">{visibleRows.map(({ group, creators }) => {
          const sales = ownerSalesByKey.get(group.key) ?? salesRollup([]);
          const progress = ownerProgressByKey.get(group.key) ?? null;
          return <button type="button" className="bp-owner-card" aria-pressed={group.key === ownerFilter} onClick={() => setOwnerFilter(group.key)} key={group.key}>
            <span className="bp-owner-card-head"><strong>{group.name}{group.active === false ? '（已停用）' : ''}</strong><ChevronDown size={16} aria-hidden="true" /></span>
            {progress ? <span className="bp-owner-card-stats"><span>{progress.creatorCount} 位在手达人</span><span>{progress.workItemCount} 张负责合作单</span><span>{progress.processGapCount} 项流程卡点</span><span className={progress.overdueScheduleCount || progress.overdueOwnerTaskCount || progress.overdueRelatedTaskCount ? 'bp-danger-copy' : ''}>逾期排期 {progress.overdueScheduleCount} 场 · 当前下一步逾期：本人 {progress.overdueOwnerTaskCount} 项、关联岗位/他人 {progress.overdueRelatedTaskCount} 项</span></span> : <span className="bp-owner-card-stats">{group.kind === 'report_only' ? '仅有手工填报，无当前商务推进事项' : '历史销售归属，无当前推进事项'}</span>}
            <OwnerSalesSummary rollup={sales} groupKind={group.kind} />
          </button>;
        })}</div>
      </>}
      <SalesDataQuality snapshot={snapshot} platform={platform} />
    </section>

    {ownerFilter !== ALL_OWNERS && selectedGroup && <section className="bp-detail-section" aria-labelledby="bp-detail-heading">
      <div className="bp-section-heading"><div><h3 id="bp-detail-heading">{selectedGroup.name} · {selectedGroup.kind === 'sales_only' ? '历史销售归属' : '推进明细'}</h3><p>CRM 当前负责人、合作单负责人分别展示；同一达人可有多张合作单。</p></div><button type="button" className="bp-link-button" onClick={() => setOwnerFilter(ALL_OWNERS)}>返回全部负责人</button></div>
      {selectedGroup.kind === 'sales_only' || selectedGroup.kind === 'report_only' ? <EmptyState title={selectedGroup.kind === 'sales_only' ? '历史销售归属，无当前推进事项' : '仅有手工填报，无当前商务推进事项'} description="该归属仅用于核对销售明细，不计入当前在手达人或合作进度。" /> : !selectedCreatorRows.length ? <EmptyState title="当前筛选下暂无达人进度" description="该负责人暂时没有匹配的平台、状态或搜索结果。" /> : <div className="bp-creator-list">
        {selectedCreatorRows.map((creator) => <CreatorProgress
          key={creator.key}
          creator={creator}
          groupName={selectedGroup.name}
          visibleItems={visibleGroupWorkItems(creator, selectedGroup, platform, progressFilter, snapshot.observedAt)}
          visibleSamples={visibleGroupDirectSamples(creator, selectedGroup, platform, progressFilter, snapshot.observedAt)}
          salesEntries={selectedEntries.filter((entry) => !entry.creatorKey || selectedCreatorKeys.has(entry.creatorKey))}
          ownerNameByKey={ownerNameByKey}
        />)}
      </div>}
    </section>}

    {ownerFilter === ALL_OWNERS && <section className="bp-detail-placeholder"><div><UsersRound size={18} aria-hidden="true" /><strong>选择一位负责人查看达人和合作单</strong><span>总览保留全部负责人对比；选择负责人后展开 CRM 阶段、下一步和合作单明细。</span></div></section>}

    <footer className="bp-footnote"><span>订单按支付时负责人快照或人工更正归属；计数为订单明细行，未按订单号合并。退款仅按已读取记录汇总，可能不完整。</span><span>手工填报按填报负责人单独显示；已由订单替代的填报不计入支付订单金额。</span><span>流程卡点按明确的未登记、资料不完整、驳回或退回状态统计；其他人的任务/岗位待处理不归入负责人本人逾期。</span><span>排期完成和交付验收均为内部记录，不代表平台已核验。负责人标识只用于当前授权范围内分组。</span></footer>
  </section>;
}
