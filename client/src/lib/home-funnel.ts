import type { BusinessProgressWorkspace } from '../../../shared/business-progress.ts';
import type {
  AuditEvent,
  Creator,
  CrmStage,
  Delivery,
  Followup,
  OrderLine,
  OwnerCorrection,
  Role,
  SamplePackage,
  SampleRequest,
} from '../../../shared/types.ts';
import { isAtOrBeforeObservedAt } from '../../../shared/order-view.ts';
import type { BusinessHomePlatform } from './business-home.ts';

/**
 * 经营首页两张转化漏斗的口径。只读工作区里已经能看到的记录，不改权限。
 *
 * 达人转化每一级都是「人数」，而且必须是上一级的子集，所以转化率不会超过 100%：
 * 1. 认领达人：当前权限内已有负责人的达人。公海（没有负责人）不算。这是库存，不按日期截断。
 * 2. 建联达人：认领达人里，所选周期内有跟进，或当前阶段已不是「未建联」且阶段更新落在周期内。
 *    阶段更新只认两种能稳定对上的痕迹：操作记录里的阶段变更，或管理进度上的当前阶段时间。
 *    不用达人的 updatedAt，随便改个备注也会动它。
 * 3. 申样达人：建联达人里，周期内有非草稿寄样申请的人。
 * 4. 寄样达人：申样达人里，申请已发货、已签收，或已经有物流包裹的人。
 * 5. 交付达人：寄样达人里，周期内有交付且状态不是取消的人。创建或提交落在周期内都算。
 * 6. 出单达人：交付达人里，周期内有已支付订单的人。
 *
 * 样品转化每一级是「次数」。寄样次数是申样次数的子集。
 * 交付次数按这些已寄样达人在周期内的非取消交付来数，一次寄样可以对应多次交付，允许大于寄样次数。
 * 出单次数是周期内已支付订单行数，订单不是寄样的子集，按实际笔数显示。
 * 左侧总转化率只在出单次数是申样次数的子集时计算。订单不是申样的子集时留空，界面显示「—」。
 *
 * 转化率分母为 0，或这一级当前角色看不到，显示空值（界面用「—」），不用 0% 或无穷大。
 * 分子是 0、分母大于 0 时就是 0%。发货岗看不到订单和交付，这两级是空值而不是 0。
 * 平台不是「全部」时，只计该平台的账号、申请和订单；对不上平台的申请不猜。
 * 周期外的跟进、阶段更新、申请、交付和订单都不进这一期。
 */

export interface HomeFunnelScope {
  role: Role;
  memberId: string;
  teamIds: string[];
}

export interface HomeFunnelQuery {
  scope: HomeFunnelScope;
  range: { from: string; to: string };
  platform: BusinessHomePlatform;
  observedAt?: string;
}

export interface HomeFunnelStageTouch {
  creatorId: string;
  stage: CrmStage;
  at: string | null;
}

export interface HomeFunnelRecords {
  creators: Creator[];
  followups: Followup[];
  auditEvents: AuditEvent[];
  stageTouches: HomeFunnelStageTouch[];
  samples: SampleRequest[];
  samplePackages: SamplePackage[];
  deliveries: Delivery[];
  orders: OrderLine[];
  ownerCorrections: OwnerCorrection[];
}

export interface HomeFunnelStage {
  key: string;
  label: string;
  /** null 表示这一级不在当前角色的可见范围里。 */
  count: number | null;
  hint?: string;
  /** 用来核对「下一级是上一级子集」。次数漏斗里交付、出单不要求是申请的子集。 */
  ids: string[];
}

export interface HomeFunnelRate {
  label: string;
  /** null 表示分母为 0，或分子、分母有一侧不可见。 */
  value: number | null;
}

export interface HomeCreatorFunnel {
  title: '达人转化';
  overall: number | null;
  /** What the left-hand rate divides, for example 出单/认领. */
  overallLabel: string;
  overallNote: string | null;
  stages: HomeFunnelStage[];
  rates: HomeFunnelRate[];
}

export interface HomeSampleFunnel {
  title: '样品转化';
  overall: number | null;
  overallLabel: string;
  /** Set when paid orders are not a subset of this period's sample requests. */
  overallNote: string | null;
  stages: HomeFunnelStage[];
  rates: HomeFunnelRate[];
}

export interface HomeFunnels {
  creators: HomeCreatorFunnel;
  samples: HomeSampleFunnel;
}

const STAGE_CHANGE_ACTIONS = new Set(['creator.stage_changed', 'creator.stage_advanced_from_followup']);

export function homeFunnelVisibility(role: Role) {
  return {
    ordersVisible: role !== 'ops',
    deliveriesVisible: role !== 'ops',
  };
}

export function stageTouchesFromProgress(progress: BusinessProgressWorkspace | undefined): HomeFunnelStageTouch[] {
  if (!progress) return [];
  return progress.creatorRelations.map((row) => ({
    creatorId: row.key,
    stage: row.crmStage,
    at: row.crmStageAt,
  }));
}

export function formatHomeFunnelCount(count: number | null) {
  if (count === null) return '—';
  return count.toLocaleString('zh-CN');
}

/** 0 显示 0%；分母为空显示 —；很小的正数四舍五入后变成 0 时标明不到 0.01%。 */
export function formatHomeFunnelRate(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '—';
  if (value === 0) return '0%';
  const rounded = Math.round(value * 10000) / 100;
  if (rounded === 0) return '<0.01%';
  const text = rounded.toFixed(2).replace(/\.?0+$/, '');
  return `${text}%`;
}

export function buildHomeFunnels(query: HomeFunnelQuery, records: HomeFunnelRecords): HomeFunnels {
  const visibility = homeFunnelVisibility(query.scope.role);
  const creatorsById = new Map(records.creators.map((creator) => [creator.id, creator]));
  const claimed = records.creators.filter((creator) => isClaimedCreator(creator, query));
  const claimedIds = new Set(claimed.map((creator) => creator.id));
  const contactedIds = contactedCreatorIds(claimed, query, records);
  const periodSamples = records.samples.filter((sample) => isPeriodSample(sample, creatorsById.get(sample.creatorId), query));
  const packagesBySample = packagesInScope(records.samplePackages, query);
  const shippedSamples = periodSamples.filter((sample) => isShippedSample(sample, packagesBySample));
  const sampledCreatorIds = creatorIdsWithSamples(contactedIds, periodSamples);
  const shippedCreatorIds = creatorIdsWithSamples(sampledCreatorIds, shippedSamples);
  const periodDeliveries = visibility.deliveriesVisible
    ? records.deliveries.filter((delivery) => isPeriodDelivery(delivery, creatorsById.get(delivery.creatorId), query))
    : [];
  const deliveredCreatorIds = visibility.deliveriesVisible
    ? creatorIdsWithDeliveries(shippedCreatorIds, periodDeliveries)
    : null;
  const periodOrders = visibility.ordersVisible
    ? records.orders.filter((order) => isPeriodOrder(order, query, records.ownerCorrections))
    : [];
  const orderedCreatorIds = visibility.ordersVisible && deliveredCreatorIds
    ? creatorIdsWithOrders(deliveredCreatorIds, periodOrders)
    : null;

  const creatorStages: HomeFunnelStage[] = [
    stage('claimed', '认领达人', [...claimedIds], '当前在管'),
    stage('contacted', '建联达人', [...contactedIds]),
    stage('sampled', '申样达人', [...sampledCreatorIds]),
    stage('shipped', '寄样达人', [...shippedCreatorIds]),
    deliveredCreatorIds
      ? stage('delivered', '交付达人', [...deliveredCreatorIds])
      : hiddenStage('delivered', '交付达人'),
    orderedCreatorIds
      ? stage('ordered', '出单达人', [...orderedCreatorIds], '交付后才出单')
      : hiddenStage('ordered', '出单达人'),
  ];
  const creatorRates: HomeFunnelRate[] = [
    namedRate('建联率', creatorStages[1].count, creatorStages[0].count),
    namedRate('申样率', creatorStages[2].count, creatorStages[1].count),
    namedRate('寄样率', creatorStages[3].count, creatorStages[2].count),
    namedRate('交付率', creatorStages[4].count, creatorStages[3].count),
    namedRate('出单率', creatorStages[5].count, creatorStages[4].count),
  ];

  const shippedSampleCreatorIds = new Set(shippedSamples.map((sample) => sample.creatorId));
  const sampleDeliveries = visibility.deliveriesVisible
    ? periodDeliveries.filter((delivery) => shippedSampleCreatorIds.has(delivery.creatorId))
    : null;
  const sampleStages: HomeFunnelStage[] = [
    stage('requests', '申样次数', periodSamples.map((sample) => sample.id)),
    stage('shipped', '寄样次数', shippedSamples.map((sample) => sample.id)),
    sampleDeliveries
      ? stage('delivered', '交付次数', sampleDeliveries.map((delivery) => delivery.id))
      : hiddenStage('delivered', '交付次数'),
    visibility.ordersVisible
      ? stage('ordered', '出单次数', periodOrders.map((order) => order.id))
      : hiddenStage('ordered', '出单次数'),
  ];
  const sampleRates: HomeFunnelRate[] = [
    namedRate('寄样率', sampleStages[1].count, sampleStages[0].count),
    namedRate('交付率', sampleStages[2].count, sampleStages[1].count),
    namedRate('出单率', sampleStages[3].count, sampleStages[2].count),
  ];

  const sampleOverall = explainSampleOverall(sampleStages[3], sampleStages[0]);
  return {
    creators: {
      title: '达人转化',
      overall: rate(creatorStages[5].count, creatorStages[0].count),
      overallLabel: '出单/认领',
      overallNote: null,
      stages: creatorStages,
      rates: creatorRates,
    },
    samples: {
      title: '样品转化',
      overall: sampleOverall.value,
      overallLabel: '出单/申样',
      overallNote: sampleOverall.note,
      stages: sampleStages,
      rates: sampleRates,
    },
  };
}

/** True when any visible stage has a positive count. Hidden stages do not count as activity. */
export function homeFunnelHasActivity(stages: HomeFunnelStage[]) {
  return stages.some((stage) => (stage.count ?? 0) > 0);
}

/**
 * Bar width follows the count. Later stages that stay inside the first stage use the first
 * stage as the scale. A later count larger than the first uses that larger number, so it draws wider.
 * Zero and hidden stages return 0; the chart draws those as a short light track.
 */
export function homeFunnelBarWidths(stages: HomeFunnelStage[]) {
  const positive = stages.map((stage) => stage.count).filter((count): count is number => count !== null && count > 0);
  const first = stages[0]?.count;
  const scale = Math.max(typeof first === 'number' && first > 0 ? first : 0, ...positive, 0);
  return stages.map((stage) => {
    if (stage.count === null || stage.count <= 0 || scale <= 0) return 0;
    return Math.max(4, Math.round((stage.count / scale) * 100));
  });
}

/** Shipping does not manage creators, so an all-zero creator funnel is not shown. */
export function showHomeCreatorFunnel(role: Role, stages: HomeFunnelStage[]) {
  if (role === 'ops' && !homeFunnelHasActivity(stages)) return false;
  return true;
}

function isClaimedCreator(creator: Creator, query: HomeFunnelQuery) {
  if (query.scope.role === 'ops') return false;
  if (creator.archived || creator.ownerMemberId === null) return false;
  if (!query.scope.teamIds.includes(creator.teamId)) return false;
  if (query.scope.role === 'bd' && creator.ownerMemberId !== query.scope.memberId) return false;
  if (query.platform !== 'all' && !creator.accounts.some((account) => account.platform === query.platform)) return false;
  return true;
}

function contactedCreatorIds(claimed: Creator[], query: HomeFunnelQuery, records: HomeFunnelRecords) {
  const claimedById = new Map(claimed.map((creator) => [creator.id, creator]));
  const ids = new Set<string>();
  for (const followup of records.followups) {
    const creator = claimedById.get(followup.creatorId);
    if (!creator || !query.scope.teamIds.includes(followup.teamId)) continue;
    if (!inPeriod(followup.occurredAt, query) || !followupOnPlatform(followup, creator, query.platform)) continue;
    ids.add(creator.id);
  }
  for (const event of records.auditEvents) {
    if (event.entityType !== 'creator' || !STAGE_CHANGE_ACTIONS.has(event.action)) continue;
    const creator = claimedById.get(event.entityId);
    if (!creator || creator.crmStage === 'uncontacted' || !query.scope.teamIds.includes(event.teamId)) continue;
    if (!inPeriod(event.occurredAt, query) || !stageAfterUpdate(event)) continue;
    ids.add(creator.id);
  }
  for (const touch of records.stageTouches) {
    const creator = claimedById.get(touch.creatorId);
    if (!creator || creator.crmStage === 'uncontacted' || touch.stage === 'uncontacted') continue;
    if (!touch.at || !inPeriod(touch.at, query)) continue;
    ids.add(creator.id);
  }
  return ids;
}

function stageAfterUpdate(event: AuditEvent) {
  const stage = event.after?.stage;
  return typeof stage === 'string' && stage !== 'uncontacted';
}

function followupOnPlatform(followup: Followup, creator: Creator, platform: BusinessHomePlatform) {
  if (platform === 'all' || !followup.accountId) return true;
  const account = creator.accounts.find((item) => item.id === followup.accountId);
  return account?.platform === platform;
}

function isPeriodSample(sample: SampleRequest, creator: Creator | undefined, query: HomeFunnelQuery) {
  if (sample.status === 'draft') return false;
  if (!query.scope.teamIds.includes(sample.teamId)) return false;
  if (!sampleInRole(sample, creator, query.scope)) return false;
  if (!sampleOnPlatform(sample, creator, query.platform)) return false;
  return inPeriod(sample.createdAt, query);
}

function sampleInRole(sample: SampleRequest, creator: Creator | undefined, scope: HomeFunnelScope) {
  if (scope.role === 'ops' || scope.role === 'admin' || scope.role === 'manager') return true;
  return sample.applicantId === scope.memberId || creator?.ownerMemberId === scope.memberId;
}

function sampleOnPlatform(sample: SampleRequest, creator: Creator | undefined, platform: BusinessHomePlatform) {
  if (platform === 'all') return true;
  if (sample.platform) return sample.platform === platform;
  if (!sample.creatorAccountId || !creator) return false;
  const account = creator.accounts.find((item) => item.id === sample.creatorAccountId);
  return account?.platform === platform;
}

function packagesInScope(packages: SamplePackage[], query: HomeFunnelQuery) {
  const grouped = new Map<string, SamplePackage[]>();
  for (const item of packages) {
    if (!query.scope.teamIds.includes(item.teamId)) continue;
    const list = grouped.get(item.sampleId) ?? [];
    list.push(item);
    grouped.set(item.sampleId, list);
  }
  return grouped;
}

function isShippedSample(sample: SampleRequest, packagesBySample: Map<string, SamplePackage[]>) {
  return sample.status === 'shipped' || sample.status === 'received' || (packagesBySample.get(sample.id)?.length ?? 0) > 0;
}

function creatorIdsWithSamples(parentIds: Set<string>, samples: SampleRequest[]) {
  const ids = new Set<string>();
  for (const sample of samples) {
    if (parentIds.has(sample.creatorId)) ids.add(sample.creatorId);
  }
  return ids;
}

function isPeriodDelivery(delivery: Delivery, creator: Creator | undefined, query: HomeFunnelQuery) {
  if (!homeFunnelVisibility(query.scope.role).deliveriesVisible) return false;
  if (delivery.status === 'cancelled') return false;
  if (!query.scope.teamIds.includes(delivery.teamId)) return false;
  if (query.scope.role === 'bd' && delivery.ownerMemberId !== query.scope.memberId && creator?.ownerMemberId !== query.scope.memberId) return false;
  const submittedInPeriod = delivery.submissions.some((submission) => inPeriod(submission.submittedAt, query));
  return inPeriod(delivery.createdAt, query) || submittedInPeriod;
}

function creatorIdsWithDeliveries(parentIds: Set<string>, deliveries: Delivery[]) {
  const ids = new Set<string>();
  for (const delivery of deliveries) {
    if (parentIds.has(delivery.creatorId)) ids.add(delivery.creatorId);
  }
  return ids;
}

function isPeriodOrder(order: OrderLine, query: HomeFunnelQuery, corrections: OwnerCorrection[]) {
  if (!homeFunnelVisibility(query.scope.role).ordersVisible) return false;
  if (order.status !== 'paid' || !query.scope.teamIds.includes(order.teamId)) return false;
  if (query.platform !== 'all' && order.platform !== query.platform) return false;
  if (query.scope.role === 'bd' && effectiveOwnerId(order, corrections) !== query.scope.memberId) return false;
  return inPeriod(order.paidAt, query);
}

function creatorIdsWithOrders(parentIds: Set<string>, orders: OrderLine[]) {
  const ids = new Set<string>();
  for (const order of orders) {
    if (order.creatorId && parentIds.has(order.creatorId)) ids.add(order.creatorId);
  }
  return ids;
}

/** 与工作区订单归属一致：有人工更正时用最新一条，否则用支付时的负责人。 */
function effectiveOwnerId(order: OrderLine, corrections: OwnerCorrection[]) {
  const latest = corrections
    .filter((item) => item.orderLineId === order.id)
    .sort((left, right) => Date.parse(right.recordedAt) - Date.parse(left.recordedAt) || right.id.localeCompare(left.id))[0];
  return latest ? latest.correctedMemberId : order.ownerSnapshot.memberId;
}

function inPeriod(value: string | null | undefined, query: HomeFunnelQuery) {
  if (!value) return false;
  if (!isDateKey(query.range.from) || !isDateKey(query.range.to) || query.range.from > query.range.to) return false;
  if (query.observedAt && !isAtOrBeforeObservedAt(value, query.observedAt)) return false;
  const day = shanghaiDateKey(value);
  return Boolean(day) && day >= query.range.from && day <= query.range.to;
}

function stage(key: string, label: string, ids: string[], hint?: string): HomeFunnelStage {
  const unique = [...new Set(ids)].sort();
  return { key, label, count: unique.length, hint, ids: unique };
}

function hiddenStage(key: string, label: string): HomeFunnelStage {
  return { key, label, count: null, ids: [] };
}

function namedRate(label: string, numerator: number | null, denominator: number | null): HomeFunnelRate {
  return { label, value: rate(numerator, denominator) };
}

function rate(numerator: number | null, denominator: number | null) {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return numerator / denominator;
}

/** 出单不是申样子集时不算出总转化率，避免订单笔数除以申样次数超过 100%。 */
function explainSampleOverall(orders: HomeFunnelStage, requests: HomeFunnelStage): { value: number | null; note: string | null } {
  if (orders.count === null || requests.count === null) return { value: null, note: null };
  const requestIds = new Set(requests.ids);
  if (!orders.ids.every((id) => requestIds.has(id))) return { value: null, note: '出单不从本次申样计算' };
  return { value: rate(orders.count, requests.count), note: null };
}

function isDateKey(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function shanghaiDateKey(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
