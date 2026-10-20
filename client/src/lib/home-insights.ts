import type { Cooperation, Delivery, DeliveryStatus, Role, WorkspaceSnapshot } from '../../../shared/types.ts';
import { isAtOrBeforeObservedAt } from '../../../shared/order-view.ts';
import type { BusinessHomePlatform } from './business-home.ts';
import { selectAwaitingReceiptSamples, selectPendingApprovalRoster } from './sample-queue.ts';

export interface HomeActorScope {
  role: Role;
  memberId: string;
}

export interface PeriodRange {
  from: string;
  to: string;
}

export interface HomePeriodKpis {
  paidCents: number;
  paidCount: number;
  paidUnknownCount: number;
  refundCents: number;
  refundCount: number;
  sellingCreators: number;
  sellingProducts: number;
  sampleCreators: number;
  sampleRequests: number;
  newCooperations: number;
  completedLives: number;
}

export type ChangeRatio = { kind: 'ratio'; value: number } | { kind: 'new' } | { kind: 'none' };

export interface HomeTodoCounts {
  pendingApproval: number;
  pendingShipment: number;
  awaitingReceipt: number;
  pendingDelivery: number;
  overdueTasks: number;
}

/** Same-length window immediately before the selected range; empty when the range is invalid. */
export function previousRange(range: PeriodRange): PeriodRange | null {
  if (!isDateKey(range.from) || !isDateKey(range.to) || range.from > range.to) return null;
  const start = Date.parse(`${range.from}T00:00:00Z`);
  const end = Date.parse(`${range.to}T00:00:00Z`);
  const days = Math.round((end - start) / 86_400_000) + 1;
  const prevEnd = new Date(start - 86_400_000);
  const prevStart = new Date(start - days * 86_400_000);
  return { from: prevStart.toISOString().slice(0, 10), to: prevEnd.toISOString().slice(0, 10) };
}

export function changeRatio(current: number, previous: number): ChangeRatio {
  if (previous === 0) return current === 0 ? { kind: 'none' } : { kind: 'new' };
  return { kind: 'ratio', value: (current - previous) / Math.abs(previous) };
}

function inScope(actor: HomeActorScope, teamIds: string[], item: { teamId: string; ownerMemberId?: string | null; applicantId?: string }) {
  if (!teamIds.includes(item.teamId)) return false;
  if (actor.role !== 'bd') return true;
  return item.ownerMemberId === actor.memberId || item.applicantId === actor.memberId;
}

export function buildHomePeriodKpis(workspace: WorkspaceSnapshot, actor: HomeActorScope, range: PeriodRange, platform: BusinessHomePlatform): HomePeriodKpis {
  const observedAt = workspace.metrics.observedAt;
  const teamIds = workspace.scope.teamIds;
  const inRange = (value: string | null | undefined) => {
    if (!value) return false;
    const day = shanghaiDateKey(value);
    return Boolean(day) && day >= range.from && day <= range.to;
  };
  const platformMatches = (value: string | null | undefined) => platform === 'all' || value === platform;
  const creatorsOnPlatform = platform === 'all'
    ? null
    : new Set(workspace.creators.filter((creator) => creator.accounts.some((account) => account.platform === platform)).map((creator) => creator.id));

  const orders = workspace.orders.filter((order) => order.status === 'paid'
    && isAtOrBeforeObservedAt(order.paidAt, observedAt)
    && platformMatches(order.platform)
    && inRange(order.paidAt));
  const refunds = workspace.metrics.dataCoverage.refundDataStatus === 'records_only'
    ? workspace.refunds.filter((refund) => refund.status === 'succeeded'
      && isAtOrBeforeObservedAt(refund.refundedAt, observedAt)
      && platformMatches(refund.platform)
      && inRange(refund.refundedAt))
    : [];
  const samples = workspace.samples.filter((sample) => sample.status !== 'draft'
    && inScope(actor, teamIds, { teamId: sample.teamId, applicantId: sample.applicantId, ownerMemberId: workspace.creators.find((creator) => creator.id === sample.creatorId)?.ownerMemberId })
    && (platform === 'all' || sample.platform === platform)
    && inRange(sample.createdAt));
  const cooperations = workspace.cooperations.filter((cooperation) => !['draft', 'rejected', 'cancelled'].includes(cooperation.status)
    && inScope(actor, teamIds, cooperation)
    && (!creatorsOnPlatform || creatorsOnPlatform.has(cooperation.creatorId))
    && inRange(cooperation.createdAt));
  const lives = workspace.schedules.filter((schedule) => schedule.status === 'completed'
    && inScope(actor, teamIds, schedule)
    && platformMatches(schedule.platform)
    && inRange(schedule.actualStartAt ?? schedule.plannedStartAt));

  return {
    paidCents: orders.reduce((sum, order) => (order.paidAmountCents === null ? sum : sum + order.paidAmountCents), 0),
    paidCount: orders.length,
    paidUnknownCount: orders.filter((order) => order.paidAmountCents === null).length,
    refundCents: refunds.reduce((sum, refund) => {
      if (refund.amountCents === null) return sum;
      return sum + (refund.direction === 'refund' ? refund.amountCents : -refund.amountCents);
    }, 0),
    refundCount: refunds.length,
    sellingCreators: new Set(orders.map((order) => order.creatorId).filter(Boolean)).size,
    sellingProducts: new Set(orders.map((order) => order.productId).filter(Boolean)).size,
    sampleCreators: new Set(samples.map((sample) => sample.creatorId)).size,
    sampleRequests: samples.length,
    newCooperations: cooperations.length,
    completedLives: lives.length,
  };
}

export function buildHomeTodoCounts(workspace: WorkspaceSnapshot, actor: HomeActorScope, now = Date.now()): HomeTodoCounts {
  const teamIds = workspace.scope.teamIds;
  const ownerOf = (creatorId: string) => workspace.creators.find((creator) => creator.id === creatorId)?.ownerMemberId ?? null;
  const visibleSamples = workspace.samples.filter((sample) => actor.role === 'ops'
    ? teamIds.includes(sample.teamId)
    : inScope(actor, teamIds, { teamId: sample.teamId, applicantId: sample.applicantId, ownerMemberId: ownerOf(sample.creatorId) }));
  const roster = { samples: visibleSamples, creators: workspace.creators, actor, teamIds };
  return {
    pendingApproval: selectPendingApprovalRoster(roster).length,
    pendingShipment: visibleSamples.filter((sample) => sample.status === 'pending_shipment').length,
    awaitingReceipt: selectAwaitingReceiptSamples({ ...roster, samplePackages: workspace.samplePackages }).length,
    pendingDelivery: selectContentDeliveryCooperations(workspace, actor).length,
    overdueTasks: workspace.tasks.filter((task) => task.status === 'open'
      && task.dueAt !== null && Date.parse(task.dueAt) < now
      && teamIds.includes(task.teamId)
      && (actor.role !== 'bd' || task.ownerMemberId === actor.memberId)).length,
  };
}

const CONTENT_DELIVERY_STATUSES: DeliveryStatus[] = ['pending_submission', 'pending_review', 'returned'];

/** A cooperation is waiting on content when its own status says so, or a delivery on it still is. */
export function isContentDeliveryPending(cooperation: Pick<Cooperation, 'id' | 'status'>, deliveries: readonly Pick<Delivery, 'cooperationId' | 'status'>[]) {
  if (cooperation.status === 'pending_delivery') return true;
  return deliveries.some((delivery) => delivery.cooperationId === cooperation.id && CONTENT_DELIVERY_STATUSES.includes(delivery.status));
}

export function selectContentDeliveryCooperations(workspace: WorkspaceSnapshot, actor: HomeActorScope) {
  const teamIds = workspace.scope.teamIds;
  return workspace.cooperations.filter((cooperation) => inScope(actor, teamIds, cooperation)
    && isContentDeliveryPending(cooperation, workspace.deliveries.filter((delivery) => inScope(actor, teamIds, delivery))));
}

/** All paid rows lack an amount. Callers should not format that as ¥0.00. */
export function homePaidAmountText(input: { paidCount: number; paidUnknownCount: number }) {
  if (input.paidCount > 0 && input.paidUnknownCount === input.paidCount) return '金额待补充';
  return null;
}

/** The empty start, before any creator or sample exists and the next step is still the catalog. */
export function homeFocusesFirstSetup(input: { nextTaskTitle: string | null; creatorCount: number; nonDraftSampleCount: number }) {
  return input.nextTaskTitle === '录入店铺与商品' && input.creatorCount === 0 && input.nonDraftSampleCount === 0;
}

/** When something is waiting, the greeting names the same item as the largest card. */
export function homeHeroSentence(input: { firstSetup: boolean; nextTaskTitle: string | null; cards: Array<{ label: string; count: number }> }) {
  if (input.firstSetup && input.nextTaskTitle) return `先做一件事：${input.nextTaskTitle}`;
  const top = input.cards.filter((card) => card.count > 0).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, 'zh-CN'))[0];
  if (!top) return '今天没有待处理事项，可以去推进新的达人合作';
  return `先处理「${top.label}」，一共 ${top.count} 件`;
}

export function greetingFor(date = new Date()) {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric', hourCycle: 'h23' }).format(date));
  if (hour < 6) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 13) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

function isDateKey(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function shanghaiDateKey(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
