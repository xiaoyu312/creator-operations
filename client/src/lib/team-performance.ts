import { PLATFORMS, type Creator, type ManualStore, type OrderLine, type Platform, type RefundEvent, type SamplePackage, type SampleRequest, type WorkspaceSnapshot } from '../../../shared/types.ts';
import { filterOrdersForView, filterRefundsForView, isAtOrBeforeObservedAt, resolveOrderOwner } from '../../../shared/order-view.ts';
import { sampleMatchesPlatform } from './sample-queue.ts';
import type { OrderViewPlatform } from './order-view.ts';

export interface TeamPerformanceFilters {
  dateFrom: string;
  dateTo: string;
  platform: OrderViewPlatform;
  shopId: string;
  shopPlatform: OrderViewPlatform;
  teamId: string;
  ownerMemberId: string;
}

export interface TeamPerformanceMemberIdentity {
  memberId: string;
  memberName: string;
  teamId: string;
  teamName: string;
}

export interface TeamPerformanceOrderRow extends TeamPerformanceMemberIdentity {
  paidOrderCount: number;
  paidKnownCents: number;
  paidUnknownCount: number;
  refundEventCount: number;
  refundSignedCents: number;
  refundUnknownCount: number;
}

export interface TeamPerformanceCreatorRow extends TeamPerformanceMemberIdentity {
  creatorCount: number;
  respondedCount: number;
  negotiatingCount: number;
  cooperatingCount: number;
}

export interface TeamPerformanceSampleRow extends TeamPerformanceMemberIdentity {
  requestCount: number;
  requestedUnitCount: number;
  pendingApprovalCount: number;
  pendingShipmentCount: number;
  waitingReceiptRequestCount: number;
  receivedCount: number;
}

export interface TeamPerformanceRows {
  visibleMembers: WorkspaceSnapshot['members'];
  visibleOrders: OrderLine[];
  visibleRefunds: RefundEvent[];
  cohortRefunds: RefundEvent[];
  refundOrderCandidates: OrderLine[];
  orders: TeamPerformanceOrderRow[];
  creators: TeamPerformanceCreatorRow[];
  samples: TeamPerformanceSampleRow[];
}

export interface ShopFilterOption {
  shopId: string;
  shopPlatform: OrderViewPlatform;
  name: string;
}

export function buildOrdersDrilldownHref({ searchParams, dateFrom, dateTo, platform, shopId, shopPlatform, teamId, ownerMemberId, actor }: {
  searchParams: URLSearchParams;
  dateFrom: string;
  dateTo: string;
  platform: OrderViewPlatform;
  shopId: string;
  shopPlatform: OrderViewPlatform;
  teamId: string;
  ownerMemberId: string;
  actor: Pick<WorkspaceSnapshot['actor'], 'memberId' | 'role'>;
}) {
  const next = new URLSearchParams(searchParams);
  next.delete('tab');
  next.delete('metric');
  if (dateFrom) next.set('dateFrom', dateFrom); else next.delete('dateFrom');
  if (dateTo) next.set('dateTo', dateTo); else next.delete('dateTo');
  if (platform === 'all') next.delete('platform'); else next.set('platform', platform);
  if (shopId === 'all') {
    next.delete('shopId');
    next.delete('shopPlatform');
  } else {
    next.set('shopId', shopId);
    next.set('shopPlatform', shopPlatform);
  }
  if (teamId === 'all') next.delete('teamId'); else next.set('teamId', teamId);
  if (actor.role === 'bd') next.set('ownerMemberId', actor.memberId);
  else if (ownerMemberId === 'all') next.delete('ownerMemberId');
  else next.set('ownerMemberId', ownerMemberId);
  const query = next.toString();
  return `/orders${query ? `?${query}` : ''}`;
}

export function encodeShopFilterValue(shopId: string, shopPlatform: OrderViewPlatform) {
  return JSON.stringify([shopPlatform, shopId]);
}

export function decodeShopFilterValue(value: string): { shopId: string; shopPlatform: OrderViewPlatform } | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') return null;
    const [shopPlatform, shopId] = parsed;
    if (shopPlatform !== 'all' && !PLATFORMS.includes(shopPlatform as Platform)) return null;
    if (!shopId) return null;
    return { shopId, shopPlatform: shopPlatform as OrderViewPlatform };
  } catch {
    return null;
  }
}

export function buildShopFilterOptions({ stores, orders, allowedTeamIds, platformFilter, selectedShopId, selectedShopPlatform }: {
  stores: readonly ManualStore[];
  orders: readonly OrderLine[];
  allowedTeamIds: readonly string[];
  platformFilter: OrderViewPlatform;
  selectedShopId: string;
  selectedShopPlatform: OrderViewPlatform;
}): ShopFilterOption[] {
  const allowedTeams = new Set(allowedTeamIds);
  const options = new Map<string, ShopFilterOption>();
  const add = (shopPlatform: OrderViewPlatform, shopId: string, name: string) => {
    if (!shopId || (platformFilter !== 'all' && shopPlatform !== 'all' && shopPlatform !== platformFilter)) return;
    const key = encodeShopFilterValue(shopId, shopPlatform);
    const previous = options.get(key);
    if (!previous || (previous.name === `店铺 ${shopId}` && name !== previous.name)) {
      options.set(key, { shopId, shopPlatform, name });
    }
  };

  for (const store of stores) {
    if (allowedTeams.has(store.teamId)) add(store.platform, store.externalShopId, store.name);
  }
  for (const order of orders) {
    if (!allowedTeams.has(order.teamId)) continue;
    if (order.shopId) add(order.platform, order.shopId, `店铺 ${order.shopId}`);
    else if (platformFilter === 'all' || order.platform === platformFilter) add(platformFilter === 'all' ? 'all' : order.platform, '__unknown__', '未填写店铺');
  }
  if (selectedShopId !== 'all') {
    if (selectedShopId === '__unknown__') add(selectedShopPlatform, selectedShopId, '未填写店铺');
    else add(selectedShopPlatform, selectedShopId, `店铺 ${selectedShopId}`);
  }

  return [...options.values()].sort((left, right) =>
    left.shopPlatform.localeCompare(right.shopPlatform) || left.name.localeCompare(right.name, 'zh-CN') || left.shopId.localeCompare(right.shopId, 'zh-CN'),
  );
}

export function matchesShopFilter(shopId: string | null, rowPlatform: OrderViewPlatform, filterShopId: string, filterShopPlatform: OrderViewPlatform = 'all') {
  if (!filterShopId || filterShopId === 'all') return true;
  if (filterShopPlatform !== 'all' && rowPlatform !== filterShopPlatform) return false;
  if (filterShopId === '__unknown__') return shopId === null;
  return shopId === filterShopId;
}

const EMPTY_ROWS: TeamPerformanceRows = {
  visibleMembers: [],
  visibleOrders: [],
  visibleRefunds: [],
  cohortRefunds: [],
  refundOrderCandidates: [],
  orders: [],
  creators: [],
  samples: [],
};

/** Builds order, creator, and sample rows inside the workspace's authorized teams and owner scope. */
export function buildTeamPerformanceRows({ workspace, actor, filters }: {
  workspace: WorkspaceSnapshot;
  actor: Pick<WorkspaceSnapshot['actor'], 'memberId' | 'role'>;
  filters: TeamPerformanceFilters;
}): TeamPerformanceRows {
  const allowedTeamIds = new Set(workspace.scope.teamIds);
  const selectedTeamId = filters.teamId === 'all' || allowedTeamIds.has(filters.teamId) ? filters.teamId : null;
  if (selectedTeamId === null) return EMPTY_ROWS;

  const isBusinessManager = actor.role === 'admin' || actor.role === 'manager';
  const ownerMemberId = actor.role === 'bd' ? actor.memberId : filters.ownerMemberId === 'all' ? null : filters.ownerMemberId;
  const teamMatches = (teamId: string) => allowedTeamIds.has(teamId) && (selectedTeamId === 'all' || teamId === selectedTeamId);
  const visibleMembers = workspace.members.filter((member) =>
    teamMatches(member.teamId) &&
    (isBusinessManager || member.id === actor.memberId) &&
    (!ownerMemberId || member.id === ownerMemberId),
  );
  const membersById = new Map(visibleMembers.map((member) => [member.id, member]));
  const teamsById = new Map(workspace.teams.map((team) => [team.id, team]));
  const identity = (memberId: string): TeamPerformanceMemberIdentity | null => {
    const member = membersById.get(memberId);
    if (!member) return null;
    return {
      memberId: member.id,
      memberName: member.displayName,
      teamId: member.teamId,
      teamName: teamsById.get(member.teamId)?.name ?? '团队未配置',
    };
  };
  const orderContext = {
    creators: workspace.creators,
    products: workspace.products,
    ownerCorrections: workspace.ownerCorrections,
  };
  const viewFilters = {
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    platform: filters.platform,
    teamId: selectedTeamId === 'all' ? null : selectedTeamId,
    ownerMemberId,
  };
  const inScopeOrders = workspace.orders.filter((order) => teamMatches(order.teamId));
  const datePlatformOwnerOrders = filterOrdersForView(inScopeOrders, viewFilters, orderContext);
  const visibleOrders = datePlatformOwnerOrders.filter((order) => matchesShopFilter(order.shopId, order.platform, filters.shopId, filters.shopPlatform));

  // Refunds use refund time for the selected period, while owner attribution comes from the linked order.
  const refundOrderCandidates = workspace.orders.filter((order) =>
    teamMatches(order.teamId) &&
    (filters.platform === 'all' || order.platform === filters.platform) &&
    matchesShopFilter(order.shopId, order.platform, filters.shopId, filters.shopPlatform) &&
    (!ownerMemberId || resolveOrderOwner(order, workspace.ownerCorrections) === ownerMemberId),
  );
  const scopedRefunds = workspace.refunds.filter((refund) => teamMatches(refund.teamId));
  const relatedOrdersById = new Map(refundOrderCandidates.map((order) => [order.id, order]));
  const visibleRefunds = filterRefundsForView(scopedRefunds, refundOrderCandidates, viewFilters, orderContext).filter((refund) => {
    const order = relatedOrdersById.get(refund.orderLineId);
    if (!order) return false;
    return matchesShopFilter(order.shopId, order.platform, filters.shopId, filters.shopPlatform);
  });
  const visibleOrderIds = new Set(visibleOrders.map((order) => order.id));
  const cohortRefunds = scopedRefunds.filter((refund) => {
    const order = relatedOrdersById.get(refund.orderLineId);
    if (!order) return false;
    return visibleOrderIds.has(refund.orderLineId) && (filters.platform === 'all' || refund.platform === filters.platform) && matchesShopFilter(order.shopId, order.platform, filters.shopId, filters.shopPlatform);
  });

  const orderRows = new Map<string, TeamPerformanceOrderRow>();
  const creatorRows = new Map<string, TeamPerformanceCreatorRow>();
  const sampleRows = new Map<string, TeamPerformanceSampleRow>();
  for (const member of visibleMembers) {
    const memberIdentity = identity(member.id);
    if (!memberIdentity) continue;
    orderRows.set(member.id, { ...memberIdentity, paidOrderCount: 0, paidKnownCents: 0, paidUnknownCount: 0, refundEventCount: 0, refundSignedCents: 0, refundUnknownCount: 0 });
    creatorRows.set(member.id, { ...memberIdentity, creatorCount: 0, respondedCount: 0, negotiatingCount: 0, cooperatingCount: 0 });
    sampleRows.set(member.id, { ...memberIdentity, requestCount: 0, requestedUnitCount: 0, pendingApprovalCount: 0, pendingShipmentCount: 0, waitingReceiptRequestCount: 0, receivedCount: 0 });
  }

  for (const order of visibleOrders) {
    if (order.status !== 'paid' || !isAtOrBeforeObservedAt(order.paidAt, workspace.metrics.observedAt)) continue;
    const row = orderRows.get(resolveOrderOwner(order, workspace.ownerCorrections) ?? '');
    if (!row) continue;
    row.paidOrderCount += 1;
    if (order.paidAmountCents === null) row.paidUnknownCount += 1;
    else row.paidKnownCents += order.paidAmountCents;
  }

  for (const refund of visibleRefunds) {
    if (refund.status !== 'succeeded' || !isAtOrBeforeObservedAt(refund.refundedAt, workspace.metrics.observedAt)) continue;
    const order = relatedOrdersById.get(refund.orderLineId);
    const row = order ? orderRows.get(resolveOrderOwner(order, workspace.ownerCorrections) ?? '') : undefined;
    if (!row) continue;
    row.refundEventCount += 1;
    if (refund.amountCents === null) row.refundUnknownCount += 1;
    else row.refundSignedCents += refund.direction === 'refund' ? refund.amountCents : -refund.amountCents;
  }

  const visibleCreators = workspace.creators.filter((creator) =>
    teamMatches(creator.teamId) &&
    (!ownerMemberId || creator.ownerMemberId === ownerMemberId) &&
    creatorHasPlatform(creator, filters.platform) &&
    dateInRange(creator.createdAt, filters.dateFrom, filters.dateTo),
  );
  for (const creator of visibleCreators) {
    if (!creator.ownerMemberId) continue;
    const row = creatorRows.get(creator.ownerMemberId);
    if (!row) continue;
    row.creatorCount += 1;
    if (creator.crmStage === 'responded') row.respondedCount += 1;
    if (creator.crmStage === 'negotiating') row.negotiatingCount += 1;
    if (creator.crmStage === 'cooperating') row.cooperatingCount += 1;
  }

  const packagesBySampleId = new Map<string, SamplePackage[]>();
  for (const samplePackage of workspace.samplePackages) {
    if (!teamMatches(samplePackage.teamId)) continue;
    const list = packagesBySampleId.get(samplePackage.sampleId) ?? [];
    list.push(samplePackage);
    packagesBySampleId.set(samplePackage.sampleId, list);
  }
  const visibleSamples = workspace.samples.filter((sample) => {
    if (!teamMatches(sample.teamId) || !dateInRange(sample.createdAt, filters.dateFrom, filters.dateTo)) return false;
    if (ownerMemberId && sample.applicantId !== ownerMemberId) return false;
    return sampleMatchesPlatform(sample, filters.platform);
  });
  for (const sample of visibleSamples) {
    const row = sampleRows.get(sample.applicantId);
    if (!row) continue;
    row.requestCount += 1;
    row.requestedUnitCount += sample.lines.reduce((sum, line) => sum + line.quantity, 0);
    if (sample.status === 'pending_approval') row.pendingApprovalCount += 1;
    if (sample.status === 'pending_shipment') row.pendingShipmentCount += 1;
    if (sample.status === 'received') row.receivedCount += 1;
    if (sample.status === 'shipped' && (packagesBySampleId.get(sample.id) ?? []).some((samplePackage) => !samplePackage.receivedAt)) row.waitingReceiptRequestCount += 1;
  }

  const byMember = <T extends TeamPerformanceMemberIdentity>(left: T, right: T) => left.teamName.localeCompare(right.teamName, 'zh-CN') || left.memberName.localeCompare(right.memberName, 'zh-CN');
  return {
    visibleMembers,
    visibleOrders,
    visibleRefunds,
    cohortRefunds,
    refundOrderCandidates,
    orders: [...orderRows.values()].sort(byMember),
    creators: [...creatorRows.values()].sort(byMember),
    samples: [...sampleRows.values()].sort(byMember),
  };
}

function creatorHasPlatform(creator: Creator | undefined, platform: OrderViewPlatform) {
  return platform === 'all' || Boolean(creator?.accounts.some((account) => account.platform === platform));
}

function dateInRange(value: string, dateFrom: string, dateTo: string) {
  if (!dateFrom && !dateTo) return true;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(timestamp);
  return (!dateFrom || day >= dateFrom) && (!dateTo || day <= dateTo);
}
