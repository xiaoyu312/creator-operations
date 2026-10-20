import type { Creator, ImportBatch, OrderLine, Platform, RefundEvent, Team } from '../../../shared/types.ts';
import { creatorOrderAttribution, isAtOrBeforeObservedAt } from '../../../shared/order-view.ts';

export type BusinessHomePlatform = Platform | 'all';
export type RefundCoverageStatus = 'not_imported' | 'records_only' | 'not_visible';
export type OrderCoverageStatus = 'not_imported' | 'records_only' | 'not_visible';

export interface BusinessHomeFilters {
  from: string;
  to: string;
  platform: BusinessHomePlatform;
}

export interface BusinessHomeTrendPoint {
  date: string;
  paidCents: number;
  refundCents: number;
  paidLines: number;
  refundEvents: number;
  unknownPaidAmountCount: number;
  unknownRefundAmountCount: number;
}

export interface BusinessHomeRankingRow {
  id: string;
  name: string;
  count: number;
  knownCents: number;
  unknownAmountCount: number;
}

export type BusinessHomeRankingAmount =
  | { status: 'complete'; knownCents: number }
  | { status: 'missing' }
  | { status: 'partial'; knownCents: number; unknownCount: number };

export interface BusinessHomeFacts {
  orders: OrderLine[];
  refunds: RefundEvent[];
  paid: { status: OrderCoverageStatus; count: number; knownCents: number; unknownCount: number; complete: boolean };
  refund: { status: RefundCoverageStatus; count: number; signedCents: number; unknownCount: number };
  trend: BusinessHomeTrendPoint[];
  teamRanking: BusinessHomeRankingRow[];
  creatorRanking: BusinessHomeRankingRow[];
  ambiguousCreatorOrderCount: number;
}

export function getBusinessOrderSourceStatus(input: {
  orders: OrderLine[];
  importBatches: ImportBatch[];
  importHistoryVisible: boolean;
}): OrderCoverageStatus {
  if (input.orders.length > 0) return 'records_only';
  if (!input.importHistoryVisible) return 'not_visible';
  // Duplicate or accepted counts without a visible order row are not an order source.
  return 'not_imported';
}

export function getBusinessHomeRankingAmount(row: BusinessHomeRankingRow): BusinessHomeRankingAmount {
  if (row.unknownAmountCount === 0) return { status: 'complete', knownCents: row.knownCents };
  if (row.unknownAmountCount >= row.count) return { status: 'missing' };
  return { status: 'partial', knownCents: row.knownCents, unknownCount: row.unknownAmountCount };
}

export function buildBusinessHomeFacts(input: {
  orders: OrderLine[];
  refunds: RefundEvent[];
  creators: Creator[];
  teams: Team[];
  orderStatus: OrderCoverageStatus;
  refundStatus: RefundCoverageStatus;
  observedAt: string;
  filters: BusinessHomeFilters;
}): BusinessHomeFacts {
  const { from, to, platform } = input.filters;
  const orders = input.orders.filter((order) => {
    if (order.status !== 'paid' || !isAtOrBeforeObservedAt(order.paidAt, input.observedAt)) return false;
    if (platform !== 'all' && order.platform !== platform) return false;
    return dateInRange(shanghaiDateKey(order.paidAt), from, to);
  });
  const refunds = input.refundStatus === 'records_only'
    ? input.refunds.filter((refund) => {
      if (refund.status !== 'succeeded' || !isAtOrBeforeObservedAt(refund.refundedAt, input.observedAt)) return false;
      if (platform !== 'all' && refund.platform !== platform) return false;
      return dateInRange(shanghaiDateKey(refund.refundedAt), from, to);
    })
    : [];

  const paidUnknown = orders.filter((order) => order.paidAmountCents === null).length;
  const refundUnknown = refunds.filter((refund) => refund.amountCents === null).length;
  const paidKnownCents = sumKnown(orders.map((order) => order.paidAmountCents));
  const refundSignedCents = refunds.reduce((sum, refund) => {
    if (refund.amountCents === null) return sum;
    return sum + (refund.direction === 'refund' ? refund.amountCents : -refund.amountCents);
  }, 0);

  const trend = buildTrend(orders, refunds, from, to, input.orderStatus === 'records_only');
  const teamNames = new Map(input.teams.map((team) => [team.id, team.name]));
  const teamSums = new Map<string, BusinessHomeRankingRow>();
  for (const order of orders) {
    const existing = teamSums.get(order.teamId) ?? {
      id: order.teamId,
      name: teamNames.get(order.teamId) ?? '团队记录不可见',
      count: 0,
      knownCents: 0,
      unknownAmountCount: 0,
    };
    existing.count += 1;
    if (order.paidAmountCents === null) existing.unknownAmountCount += 1;
    else existing.knownCents += order.paidAmountCents;
    teamSums.set(order.teamId, existing);
  }

  const visibleCreatorIds = new Set(input.creators.map((creator) => creator.id));
  const canonicalCreators = input.creators.filter((creator) => !creator.mergedIntoCreatorId || !visibleCreatorIds.has(creator.mergedIntoCreatorId));
  const creatorMatches = new Map<string, Set<string>>();
  for (const creator of canonicalCreators) {
    const attributed = creatorOrderAttribution(creator.id, input.creators, orders);
    for (const order of attributed.orders) {
      const matches = creatorMatches.get(order.id) ?? new Set<string>();
      matches.add(creator.id);
      creatorMatches.set(order.id, matches);
    }
  }

  const creatorSums = new Map<string, BusinessHomeRankingRow>();
  let ambiguousCreatorOrderCount = 0;
  for (const order of orders) {
    const matches = creatorMatches.get(order.id);
    if (!matches || matches.size !== 1) {
      if (matches && matches.size > 1) ambiguousCreatorOrderCount += 1;
      continue;
    }
    const creatorId = [...matches][0];
    const creator = input.creators.find((item) => item.id === creatorId);
    if (!creator) continue;
    const existing = creatorSums.get(creator.id) ?? {
      id: creator.id,
      name: creatorDisplayName(creator, platform),
      count: 0,
      knownCents: 0,
      unknownAmountCount: 0,
    };
    existing.count += 1;
    if (order.paidAmountCents === null) existing.unknownAmountCount += 1;
    else existing.knownCents += order.paidAmountCents;
    creatorSums.set(creator.id, existing);
  }

  const rank = (rows: Map<string, BusinessHomeRankingRow>) => [...rows.values()]
    .sort((left, right) => right.knownCents - left.knownCents || right.count - left.count || left.name.localeCompare(right.name, 'zh-CN'));

  return {
    orders,
    refunds,
    paid: { status: input.orderStatus, count: orders.length, knownCents: paidKnownCents, unknownCount: paidUnknown, complete: paidUnknown === 0 },
    refund: { status: input.refundStatus, count: refunds.length, signedCents: refundSignedCents, unknownCount: refundUnknown },
    trend,
    teamRanking: rank(teamSums),
    creatorRanking: rank(creatorSums),
    ambiguousCreatorOrderCount,
  };
}

function dateInRange(day: string, from: string, to: string) {
  return Boolean(day) && (!from || day >= from) && (!to || day <= to);
}

function shanghaiDateKey(value: string | Date | null) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function sumKnown(values: Array<number | null>) {
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function creatorDisplayName(creator: Creator, platform: BusinessHomePlatform) {
  const matchingAccount = platform === 'all'
    ? undefined
    : creator.accounts.find((account) => account.platform === platform);
  const account = matchingAccount ?? creator.accounts.find((item) => item.active) ?? creator.accounts[0];
  return account?.displayName || creator.name;
}

function buildTrend(orders: OrderLine[], refunds: RefundEvent[], from: string, to: string, hasOrderSource: boolean) {
  if (!hasOrderSource) return [];
  const data = new Map<string, BusinessHomeTrendPoint>();
  const ensure = (date: string) => {
    const existing = data.get(date);
    if (existing) return existing;
    const created: BusinessHomeTrendPoint = {
      date,
      paidCents: 0,
      refundCents: 0,
      paidLines: 0,
      refundEvents: 0,
      unknownPaidAmountCount: 0,
      unknownRefundAmountCount: 0,
    };
    data.set(date, created);
    return created;
  };

  for (const order of orders) {
    const row = ensure(shanghaiDateKey(order.paidAt!));
    row.paidLines += 1;
    if (order.paidAmountCents === null) row.unknownPaidAmountCount += 1;
    else row.paidCents += order.paidAmountCents;
  }
  for (const refund of refunds) {
    const row = ensure(shanghaiDateKey(refund.refundedAt!));
    row.refundEvents += 1;
    if (refund.amountCents === null) row.unknownRefundAmountCount += 1;
    else row.refundCents += refund.direction === 'refund' ? refund.amountCents : -refund.amountCents;
  }

  for (const date of dateRange(from, to)) ensure(date);
  return [...data.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function dateRange(from: string, to: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return [];
  const start = new Date(`${from}T12:00:00+08:00`);
  const end = new Date(`${to}T12:00:00+08:00`);
  const dayCount = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (!Number.isFinite(dayCount) || dayCount > 90) return [];
  return Array.from({ length: dayCount }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + index);
    return shanghaiDateKey(date);
  });
}
