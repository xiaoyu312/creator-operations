import { PLATFORMS, type OrderLine, type Platform, type RefundEvent } from '../../../shared/types.ts';
import {
  filterOrdersByDateAndPlatform,
  filterRefundsByDateAndPlatform,
  isAtOrBeforeObservedAt,
} from '../../../shared/order-view.ts';

export { filterOrdersByDateAndPlatform, filterRefundsByDateAndPlatform };

export type OrderViewPlatform = Platform | 'all';

export interface OrderDatePlatformFilters {
  dateFrom: string;
  dateTo: string;
  platform: OrderViewPlatform;
}

export interface OrderViewAmount {
  knownCents: number;
  unknownCount: number;
  complete: boolean;
}

export interface OrderViewMetrics {
  paidOrders: { count: number | null; unassignedCount: number | null; amount: OrderViewAmount | null };
  refunds: { count: number | null; amount: OrderViewAmount | null };
  netPaidCohort: { amount: OrderViewAmount | null };
}

export function normalizeOrderViewPlatform(value: string | null): OrderViewPlatform {
  return value && PLATFORMS.includes(value as Platform) ? value as Platform : 'all';
}

export function summarizeOrderViewMetrics(input: {
  orders: OrderLine[];
  visibleRefunds: RefundEvent[];
  allRefunds: RefundEvent[];
  orderSourceAvailable: boolean;
  refundSourceAvailable: boolean;
  observedAt: string;
  getOrderOwner: (order: OrderLine) => string | null;
}): OrderViewMetrics {
  const beforeCutoff = (value: string | null) => isAtOrBeforeObservedAt(value, input.observedAt);
  const paidOrders = input.orders.filter((order) => order.status === 'paid' && beforeCutoff(order.paidAt));
  const visibleRefunds = input.visibleRefunds.filter((refund) => refund.status === 'succeeded' && beforeCutoff(refund.refundedAt));
  const paidOrderIds = new Set(paidOrders.map((order) => order.id));
  const cohortRefunds = input.allRefunds.filter((refund) =>
    paidOrderIds.has(refund.orderLineId) && refund.status === 'succeeded' && beforeCutoff(refund.refundedAt),
  );

  let netKnownCents = 0;
  let netUnknownCount = 0;
  for (const order of paidOrders) {
    if (order.paidAmountCents === null) {
      netUnknownCount += 1;
      continue;
    }
    let orderNetCents = order.paidAmountCents;
    let hasUnknownRefund = false;
    for (const refund of cohortRefunds) {
      if (refund.orderLineId !== order.id) continue;
      if (refund.amountCents === null) {
        hasUnknownRefund = true;
        continue;
      }
      orderNetCents += refund.direction === 'refund' ? -refund.amountCents : refund.amountCents;
    }
    netKnownCents += orderNetCents;
    if (hasUnknownRefund) netUnknownCount += 1;
  }

  const netPaidCohort = input.orderSourceAvailable && input.refundSourceAvailable
    ? amountView(netKnownCents, netUnknownCount)
    : null;

  return {
    paidOrders: input.orderSourceAvailable
      ? {
        count: paidOrders.length,
        unassignedCount: paidOrders.filter((order) => !input.getOrderOwner(order)).length,
        amount: amountView(sumKnown(paidOrders.map((order) => order.paidAmountCents)), countUnknown(paidOrders.map((order) => order.paidAmountCents))),
      }
      : { count: null, unassignedCount: null, amount: null },
    refunds: input.refundSourceAvailable
      ? {
        count: visibleRefunds.length,
        amount: amountView(
          visibleRefunds.reduce((sum, refund) => sum + (refund.amountCents === null ? 0 : refund.direction === 'refund' ? refund.amountCents : -refund.amountCents), 0),
          visibleRefunds.filter((refund) => refund.amountCents === null).length,
        ),
      }
      : { count: null, amount: null },
    netPaidCohort: { amount: netPaidCohort },
  };
}

function amountView(knownCents: number, unknownCount: number): OrderViewAmount {
  return { knownCents, unknownCount, complete: unknownCount === 0 };
}

function sumKnown(values: Array<number | null>) {
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function countUnknown(values: Array<number | null>) {
  return values.filter((value) => value === null).length;
}
