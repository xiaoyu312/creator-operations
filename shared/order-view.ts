import type { Creator, OrderLine, OwnerCorrection, Product, RefundEvent } from './types.ts';

export type OrderViewPlatform = OrderLine['platform'] | 'all';

export interface OrderViewFilters {
  dateFrom: string;
  dateTo: string;
  platform: OrderViewPlatform;
  teamId?: string | null;
  ownerMemberId?: string | null;
  creatorId?: string | null;
  search?: string;
}

export interface OrderViewContext {
  creators: Creator[];
  products: Product[];
  ownerCorrections: OwnerCorrection[];
}

export function isAtOrBeforeObservedAt(value: string | null, observedAt: string) {
  if (!value) return false;
  const timestamp = Date.parse(value);
  const cutoff = Date.parse(observedAt);
  return Number.isFinite(timestamp) && (!Number.isFinite(cutoff) || timestamp <= cutoff);
}

export function filterOrdersByDateAndPlatform(orders: OrderLine[], filters: Pick<OrderViewFilters, 'dateFrom' | 'dateTo' | 'platform'>) {
  return orders.filter((order) =>
    (filters.platform === 'all' || order.platform === filters.platform) &&
    isDateInRange(order.paidAt, filters.dateFrom, filters.dateTo),
  );
}

export function filterRefundsByDateAndPlatform(refunds: RefundEvent[], filters: Pick<OrderViewFilters, 'dateFrom' | 'dateTo' | 'platform'>) {
  return refunds.filter((refund) =>
    (filters.platform === 'all' || refund.platform === filters.platform) &&
    isDateInRange(refund.refundedAt, filters.dateFrom, filters.dateTo),
  );
}

export function resolveOrderOwner(
  order: Pick<OrderLine, 'id' | 'ownerSnapshot'>,
  corrections: Array<Pick<OwnerCorrection, 'orderLineId' | 'recordedAt' | 'id' | 'correctedMemberId'>>,
) {
  const correction = corrections
    .filter((item) => item.orderLineId === order.id)
    .sort((left, right) => Date.parse(right.recordedAt) - Date.parse(left.recordedAt) || right.id.localeCompare(left.id))[0];
  return correction ? correction.correctedMemberId : order.ownerSnapshot.memberId;
}

export function creatorOrderAttribution<TOrder extends Pick<OrderLine, 'id' | 'platform' | 'creatorId' | 'creatorAccountId'>>(
  creatorId: string,
  visibleCreators: Array<Pick<Creator, 'id' | 'mergedIntoCreatorId'> & {
    accounts: Array<Pick<Creator['accounts'][number], 'platform' | 'externalAccountId'>>;
  }>,
  orders: TOrder[],
) {
  const byId = new Map(visibleCreators.map((creator) => [creator.id, creator]));
  const canonicalId = (startId: string) => {
    let currentId = startId;
    const visited = new Set<string>();
    while (!visited.has(currentId)) {
      visited.add(currentId);
      const nextId = byId.get(currentId)?.mergedIntoCreatorId;
      if (!nextId || !byId.has(nextId)) break;
      currentId = nextId;
    }
    return currentId;
  };
  const rootId = canonicalId(creatorId);
  const group = visibleCreators.filter((creator) => canonicalId(creator.id) === rootId);
  const creatorIds = new Set(group.map((creator) => creator.id));
  const accountKeys = new Set(group.flatMap((creator) => creator.accounts.map((account) => `${account.platform}\u0000${account.externalAccountId}`)));
  const visibleCreatorIds = new Set(visibleCreators.map((creator) => creator.id));
  const attributed: TOrder[] = [];
  let conflictingAccountLinks = 0;
  for (const order of orders) {
    if (order.creatorId && creatorIds.has(order.creatorId)) {
      attributed.push(order);
      continue;
    }
    const exactAccountMatch = Boolean(order.creatorAccountId && accountKeys.has(`${order.platform}\u0000${order.creatorAccountId}`));
    if (!exactAccountMatch) continue;
    if (order.creatorId && visibleCreatorIds.has(order.creatorId)) {
      conflictingAccountLinks += 1;
      continue;
    }
    attributed.push(order);
  }
  return { creatorIds, accountKeys, visibleCreatorIds, orders: attributed, conflictingAccountLinks };
}

export function filterOrdersForView(orders: OrderLine[], filters: OrderViewFilters, context: OrderViewContext) {
  const query = filters.search?.trim().toLowerCase() ?? '';
  const creatorOrderIds = filters.creatorId
    ? new Set(creatorOrderAttribution(filters.creatorId, context.creators, orders).orders.map((order) => order.id))
    : null;
  const creatorsById = new Map(context.creators.map((creator) => [creator.id, creator]));
  const productsById = new Map(context.products.map((product) => [product.id, product]));

  return filterOrdersByDateAndPlatform(orders, filters).filter((order) => {
    if (filters.teamId && order.teamId !== filters.teamId) return false;
    if (creatorOrderIds && !creatorOrderIds.has(order.id)) return false;
    if (filters.ownerMemberId && resolveOrderOwner(order, context.ownerCorrections) !== filters.ownerMemberId) return false;
    if (!query) return true;
    const creator = order.creatorId ? creatorsById.get(order.creatorId) : undefined;
    const product = order.productId ? productsById.get(order.productId) : undefined;
    const haystack = `${order.externalOrderId} ${order.externalLineId} ${order.sku ?? ''} ${product?.name ?? ''} ${creator?.name ?? ''} ${creator?.accounts.map((account) => account.displayName).join(' ') ?? ''}`.toLowerCase();
    return haystack.includes(query);
  });
}

export function filterRefundsForView(refunds: RefundEvent[], orders: OrderLine[], filters: OrderViewFilters, context: OrderViewContext) {
  const query = filters.search?.trim().toLowerCase() ?? '';
  const ordersById = new Map(orders.map((order) => [order.id, order]));
  const creatorOrderIds = filters.creatorId
    ? new Set(creatorOrderAttribution(filters.creatorId, context.creators, orders).orders.map((order) => order.id))
    : null;

  return filterRefundsByDateAndPlatform(refunds, filters).filter((refund) => {
    if (filters.teamId && refund.teamId !== filters.teamId) return false;
    const order = ordersById.get(refund.orderLineId);
    if (creatorOrderIds && (!order || !creatorOrderIds.has(order.id))) return false;
    if (filters.ownerMemberId && (!order || resolveOrderOwner(order, context.ownerCorrections) !== filters.ownerMemberId)) return false;
    if (!query) return true;
    const haystack = `${refund.externalRefundId} ${order?.externalOrderId ?? ''} ${order?.externalLineId ?? ''}`.toLowerCase();
    return haystack.includes(query);
  });
}

function isDateInRange(value: string | null, dateFrom: string, dateTo: string) {
  if (!dateFrom && !dateTo) return true;
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
  return (!dateFrom || day >= dateFrom) && (!dateTo || day <= dateTo);
}
