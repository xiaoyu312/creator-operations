import type {
  OrderLine,
  SalesPerformanceReport,
  SalesPerformanceWorkspaceItem,
} from "./types.ts";

/**
 * An order is a possible overlap unless a known key proves otherwise.
 * Missing shop, creator, product, or payment time stays ambiguous.
 */
export function findPotentialOrderOverlaps<TOrder extends Pick<OrderLine,
  "orgId" | "status" | "platform" | "shopId" | "creatorAccountId"
    | "creatorId" | "productId" | "paidAt">>(
  report: Pick<SalesPerformanceReport,
    "orgId" | "periodStartAt" | "periodEndAt" | "platform" | "shopId"
      | "externalAccountId" | "creatorId" | "productIds">,
  orders: TOrder[],
): TOrder[] {
  const start = Date.parse(report.periodStartAt);
  const end = Date.parse(report.periodEndAt);
  return orders.filter((order) => {
    if (order.orgId !== report.orgId) return false;
    if (order.status === "cancelled" || order.status === "closed") return false;
    if (order.platform !== null && order.platform !== undefined
      && order.platform !== report.platform) return false;
    const orderShopId = order.shopId?.trim() ?? "";
    if (orderShopId && orderShopId !== report.shopId) return false;

    const hasCreatorAccount = Boolean(order.creatorAccountId?.trim());
    const hasCreatorId = Boolean(order.creatorId?.trim());
    if (hasCreatorAccount || hasCreatorId) {
      const accountMatches = hasCreatorAccount
        && order.creatorAccountId?.trim() === report.externalAccountId;
      const creatorMatches = hasCreatorId && order.creatorId === report.creatorId;
      if (!accountMatches && !creatorMatches) return false;
    }

    const productId = order.productId?.trim() ?? "";
    if (productId && !report.productIds.includes(productId)) return false;
    if (order.paidAt?.trim()) {
      const paidAt = Date.parse(order.paidAt);
      if (Number.isFinite(paidAt) && (paidAt < start || paidAt >= end)) return false;
    }
    return true;
  });
}

export function accountingStatusForSalesReport(
  report: Pick<SalesPerformanceReport, "status" | "reconciledBy" | "reconciledAt">,
  overlappingOrderCount: number,
): SalesPerformanceWorkspaceItem["accountingStatus"] {
  if (report.status === "pending_review") return "unreviewed";
  if (report.status === "returned") return "returned";
  if (report.reconciledBy !== null || report.reconciledAt !== null) {
    return "replaced_by_orders";
  }
  return overlappingOrderCount > 0 ? "reconciliation_required" : "counted";
}

/** Derive accounting against the full order collection before workspace filters. */
export function projectSalesPerformanceReport(
  report: SalesPerformanceReport,
  allOrders: OrderLine[],
  includeOverlapCount = true,
): SalesPerformanceWorkspaceItem {
  const overlappingOrderCount = findPotentialOrderOverlaps(report, allOrders).length;
  return {
    ...report,
    accountingStatus: accountingStatusForSalesReport(report, overlappingOrderCount),
    overlappingOrderCount: includeOverlapCount ? overlappingOrderCount : null,
  };
}
