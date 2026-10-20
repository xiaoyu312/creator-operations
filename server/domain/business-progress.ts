import { createHmac } from "node:crypto";
import type { BusinessProgressActionCode, BusinessProgressCooperationWorkItem, BusinessProgressCreator, BusinessProgressCreatorSales, BusinessProgressDeliveryCount, BusinessProgressDeliveryProgress, BusinessProgressManualSalesByOwner, BusinessProgressNextAction, BusinessProgressOwner, BusinessProgressOwnerKey, BusinessProgressSampleProgress, BusinessProgressSampleProgressState, BusinessProgressSampleRequest, BusinessProgressSalesByOwner, BusinessProgressSalesEntry, BusinessProgressWorkspace } from "../../shared/business-progress.ts";
import { accountingStatusForSalesReport, findPotentialOrderOverlaps } from "../../shared/sales-performance.ts";
import { creatorOrderAttribution, resolveOrderOwner } from "../../shared/order-view.ts";
import type { DeliveryType, Id, Platform } from "../../shared/types.ts";
import type { BusinessProgressCooperationSource, BusinessProgressCreatorSource, BusinessProgressOrderSource, BusinessProgressSampleSource, BusinessProgressSource, BusinessProgressTaskSource } from "./business-progress-source.ts";

type VisibleOwner = { key: BusinessProgressOwnerKey; displayName: string; teamId: Id; active: boolean };
type SaleAmountAccumulator = {
  paidOrderLineCount: number;
  knownGrossCents: number;
  unknownOrderAmountCount: number;
  unknownPaidAtOrderLineCount: number;
  succeededRefundCount: number;
  knownRefundCents: number;
  unknownRefundAmountCount: number;
  unknownRefundDateCount: number;
  byOwner: Map<string, BusinessProgressSalesByOwner>;
  orderKeys: Set<string>;
  refundKeys: Set<string>;
};

const DELIVERY_TYPES: readonly DeliveryType[] = ["live", "short_video", "other"];

function scopeMatches(item: { orgId: string; teamId: string }, source: BusinessProgressSource, teamIds: ReadonlySet<Id>): boolean {
  return item.orgId === source.orgId && teamIds.has(item.teamId);
}

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateAtShanghai(value: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(value));
}

function latestAtOrBefore(values: readonly string[], cutoff: number): string | null {
  let latest: string | null = null;
  let latestTimestamp = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const parsed = timestamp(value);
    if (parsed !== null && parsed <= cutoff && parsed > latestTimestamp) {
      latest = value;
      latestTimestamp = parsed;
    }
  }
  return latest;
}

function canonicalCreatorId(startId: string, creatorsById: ReadonlyMap<string, BusinessProgressCreatorSource>): string {
  let current = startId;
  const visited = new Set<string>();
  while (!visited.has(current)) {
    visited.add(current);
    const next = creatorsById.get(current)?.mergedIntoCreatorId;
    if (!next || !creatorsById.has(next)) break;
    current = next;
  }
  return current;
}

function makeOwnerKey(secret: string, orgId: string, teamId: string, memberId: string): string {
  return createHmac("sha256", secret).update(`${orgId}\0${teamId}\0${memberId}`, "utf8").digest("hex");
}

function addSafeCents(current: number, amount: number): number | null {
  const sum = current + amount;
  return Number.isSafeInteger(sum) ? sum : null;
}

function blankOwnerSales(ownerKey: string | null): BusinessProgressSalesByOwner {
  return {
    ownerKey,
    paidOrderLineCount: 0,
    knownGrossCents: 0,
    unknownOrderAmountCount: 0,
    unknownPaidAtOrderLineCount: 0,
    knownRefundCents: 0,
    unknownRefundAmountCount: 0,
    unknownRefundDateCount: 0,
    knownNetCents: 0,
    netComplete: false,
  };
}

function blankSales(): SaleAmountAccumulator {
  return {
    paidOrderLineCount: 0,
    knownGrossCents: 0,
    unknownOrderAmountCount: 0,
    unknownPaidAtOrderLineCount: 0,
    succeededRefundCount: 0,
    knownRefundCents: 0,
    unknownRefundAmountCount: 0,
    unknownRefundDateCount: 0,
    byOwner: new Map(),
    orderKeys: new Set(),
    refundKeys: new Set(),
  };
}

function ownerSalesFor(sales: SaleAmountAccumulator, ownerKey: string | null): BusinessProgressSalesByOwner {
  const key = ownerKey ?? "__unknown_owner__";
  let record = sales.byOwner.get(key);
  if (!record) {
    record = blankOwnerSales(ownerKey);
    sales.byOwner.set(key, record);
  }
  return record;
}

function addGross(sales: SaleAmountAccumulator, owner: BusinessProgressSalesByOwner, amount: number | null): void {
  if (amount === null || !Number.isSafeInteger(amount) || amount < 0) {
    sales.unknownOrderAmountCount += 1;
    owner.unknownOrderAmountCount += 1;
    return;
  }
  const total = addSafeCents(sales.knownGrossCents, amount);
  const ownerTotal = addSafeCents(owner.knownGrossCents, amount);
  if (total === null || ownerTotal === null) {
    sales.unknownOrderAmountCount += 1;
    owner.unknownOrderAmountCount += 1;
    return;
  }
  sales.knownGrossCents = total;
  owner.knownGrossCents = ownerTotal;
}

function orderNaturalKey(order: BusinessProgressOrderSource): string {
  const shop = order.shopId?.trim() ?? "";
  const externalOrderId = order.externalOrderId.trim();
  const externalLineId = order.externalLineId.trim();
  if (!externalOrderId || !externalLineId) return `id:${order.id}`;
  return `${order.platform}\0${shop}\0${externalOrderId}\0${externalLineId}`;
}

function sameOrderFacts(left: BusinessProgressOrderSource, right: BusinessProgressOrderSource): boolean {
  return left.status === right.status
    && left.paidAt === right.paidAt
    && left.paidAmountCents === right.paidAmountCents
    && left.creatorId === right.creatorId
    && left.creatorAccountId === right.creatorAccountId
    && left.productId === right.productId
    && left.ownerSnapshot.memberId === right.ownerSnapshot.memberId
    && left.ownerSnapshot.assignedAt === right.ownerSnapshot.assignedAt
    && left.ownerSnapshot.ruleVersion === right.ownerSnapshot.ruleVersion
    && left.ownerSnapshot.reason === right.ownerSnapshot.reason;
}

function orderOwnerBasis(
  order: BusinessProgressOrderSource,
  corrections: BusinessProgressSource["ownerCorrections"],
  ownerKey: string | null,
): BusinessProgressSalesEntry["ownerBasis"] {
  if (corrections.some((item) => item.orderLineId === order.id)) return "correction";
  if (order.status !== "paid" || order.ownerSnapshot.reason === "payment_not_finalized") return "not_applicable";
  if (order.ownerSnapshot.reason === "ambiguous_owner") return "unknown";
  if (order.ownerSnapshot.memberId === null) return "unassigned";
  return ownerKey ? "paid_at_snapshot" : "unknown";
}

function uniqueOrders(orders: readonly BusinessProgressOrderSource[]): {
  orders: BusinessProgressOrderSource[];
  conflicts: BusinessProgressOrderSource[];
  aliasesByOrderId: Map<string, string[]>;
} {
  const byKey = new Map<string, BusinessProgressOrderSource>();
  const aliasesByOrderId = new Map<string, string[]>();
  const conflicts: BusinessProgressOrderSource[] = [];
  const conflictedKeys = new Set<string>();
  for (const order of orders) {
    const key = orderNaturalKey(order);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, order);
      aliasesByOrderId.set(order.id, [order.id]);
      continue;
    }
    if (sameOrderFacts(existing, order)) {
      aliasesByOrderId.get(existing.id)?.push(order.id);
      continue;
    }
    if (!conflictedKeys.has(key)) {
      conflicts.push(existing);
      conflictedKeys.add(key);
    }
    conflicts.push(order);
  }
  return {
    orders: [...byKey.entries()].filter(([key]) => !conflictedKeys.has(key)).map(([, order]) => order),
    conflicts,
    aliasesByOrderId,
  };
}

function sampleLineQuantities(sample: BusinessProgressSampleSource, packages: BusinessProgressSource["samplePackages"]): {
  requiredQuantity: number | null; shippedQuantity: number | null; receivedQuantity: number | null;
} {
  if (sample.lines.length === 0 || sample.lines.some((line) => !Number.isSafeInteger(line.quantity) || line.quantity <= 0)) {
    return { requiredQuantity: null, shippedQuantity: null, receivedQuantity: null };
  }
  const relatedPackages = packages.filter((item) => item.sampleId === sample.id);
  const shippedByLine = new Map<string, number>();
  const receivedByLine = new Map<string, number>();
  const sampleLineIds = new Set(sample.lines.map((line) => line.id));
  for (const pkg of relatedPackages) {
    for (const line of pkg.lines) {
      if (!sampleLineIds.has(line.sampleLineId) || !Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
        return { requiredQuantity: null, shippedQuantity: null, receivedQuantity: null };
      }
      shippedByLine.set(line.sampleLineId, (shippedByLine.get(line.sampleLineId) ?? 0) + line.quantity);
      if (pkg.receivedAt !== null) receivedByLine.set(line.sampleLineId, (receivedByLine.get(line.sampleLineId) ?? 0) + line.quantity);
    }
  }
  if (sample.lines.some((line) => (shippedByLine.get(line.id) ?? 0) > line.quantity
    || (receivedByLine.get(line.id) ?? 0) > (shippedByLine.get(line.id) ?? 0))) {
    return { requiredQuantity: null, shippedQuantity: null, receivedQuantity: null };
  }
  const requiredQuantity = sample.lines.reduce((sum, line) => sum + line.quantity, 0);
  const shippedQuantity = sample.lines.reduce((sum, line) => sum + Math.min(line.quantity, shippedByLine.get(line.id) ?? 0), 0);
  const receivedQuantity = sample.lines.reduce((sum, line) => sum + Math.min(line.quantity, receivedByLine.get(line.id) ?? 0), 0);
  if (![requiredQuantity, shippedQuantity, receivedQuantity].every(Number.isSafeInteger)) {
    return { requiredQuantity: null, shippedQuantity: null, receivedQuantity: null };
  }
  return { requiredQuantity, shippedQuantity, receivedQuantity };
}

function sampleRequestView(sample: BusinessProgressSampleSource, packages: BusinessProgressSource["samplePackages"], required: boolean): BusinessProgressSampleRequest {
  const quantities = sampleLineQuantities(sample, packages);
  return {
    key: sample.id,
    status: sample.status,
    platforms: sample.platform ? [sample.platform] : [],
    updatedAt: sample.updatedAt,
    required,
    ...quantities,
    nextAction: sampleNextAction(sample, quantities),
  };
}

function sampleState(
  cooperation: BusinessProgressCooperationSource,
  requests: BusinessProgressSampleRequest[],
  missingCount: number,
): BusinessProgressSampleProgressState {
  if (cooperation.sampleRequirement === "none") return "not_required";
  if (cooperation.samplesWaived) return "waived";
  if (cooperation.requiredSampleIds.length === 0) return "awaiting_request";
  const required = requests.filter((item) => item.required);
  if (missingCount > 0 || required.some((item) => item.requiredQuantity === null)) return "incomplete_data";
  if (required.some((item) => item.status === "rejected")) return "rejected";
  if (required.some((item) => item.status === "closed")) return "closed";
  if (required.some((item) => item.status === "pending_approval")) return "pending_approval";
  if (required.some((item) => item.shippedQuantity === null || item.requiredQuantity === null)) return "incomplete_data";
  const totalRequired = required.reduce((sum, item) => sum + (item.requiredQuantity ?? 0), 0);
  const totalShipped = required.reduce((sum, item) => sum + (item.shippedQuantity ?? 0), 0);
  const totalReceived = required.reduce((sum, item) => sum + (item.receivedQuantity ?? 0), 0);
  if (totalShipped > 0 && totalShipped < totalRequired) return "partially_shipped";
  if (totalShipped < totalRequired) return "pending_shipment";
  if (totalReceived > 0 && totalReceived < totalRequired) return "partially_received";
  if (totalReceived >= totalRequired && totalRequired > 0) return "received";
  return "shipped";
}

function sampleProgress(
  cooperation: BusinessProgressCooperationSource,
  creatorId: string,
  samples: readonly BusinessProgressSampleSource[],
  packages: BusinessProgressSource["samplePackages"],
): BusinessProgressSampleProgress {
  const requiredIds = new Set(cooperation.requiredSampleIds);
  const linkedSamples = samples.filter((sample) => sample.creatorId === creatorId
    && (sample.cooperationId === cooperation.id || requiredIds.has(sample.id)));
  const requests = linkedSamples.map((sample) => sampleRequestView(sample, packages, requiredIds.has(sample.id)));
  const byId = new Set(linkedSamples.map((sample) => sample.id));
  const missingCount = cooperation.requiredSampleIds.filter((id) => !byId.has(id)).length;
  const requiredRequests = requests.filter((item) => item.required);
  const quantityFields = ["requiredQuantity", "shippedQuantity", "receivedQuantity"] as const;
  const totals = quantityFields.map((field) => requiredRequests.every((item) => item[field] !== null)
    ? requiredRequests.reduce((sum, item) => sum + (item[field] ?? 0), 0)
    : null);
  const [requiredQuantity, shippedQuantity, receivedQuantity] = totals;
  return {
    state: sampleState(cooperation, requests, missingCount),
    requiredRequestCount: cooperation.requiredSampleIds.length,
    presentRequestCount: requiredRequests.length,
    requiredQuantity,
    shippedQuantity,
    receivedQuantity,
    requests,
  };
}

function sampleNextAction(sample: BusinessProgressSampleSource, quantities: ReturnType<typeof sampleLineQuantities>): BusinessProgressNextAction {
  const unregistered = (code: BusinessProgressActionCode): BusinessProgressNextAction => ({ state: "unregistered", code, ownerKey: null, dueAt: null, taskKind: null, requiredCapability: null });
  if (sample.status === "draft") return { state: "suggested", code: "submit_sample_request", ownerKey: null, dueAt: null, taskKind: null, requiredCapability: null };
  if (sample.status === "pending_approval") return unregistered("approve_sample_request");
  if (sample.status === "pending_shipment") return quantities.requiredQuantity === null ? unregistered("inspect_record") : unregistered("ship_samples");
  if (sample.status === "shipped" && quantities.shippedQuantity !== null && quantities.receivedQuantity !== null) {
    if (quantities.shippedQuantity < (quantities.requiredQuantity ?? Number.POSITIVE_INFINITY)) return unregistered("ship_samples");
    return unregistered(quantities.receivedQuantity < quantities.shippedQuantity ? "confirm_sample_receipt" : "inspect_record");
  }
  if (sample.status === "rejected" || sample.status === "closed" || sample.status === "received") {
    return { state: "none", code: "none", ownerKey: null, dueAt: null, taskKind: null, requiredCapability: null };
  }
  return unregistered("inspect_record");
}

function buildSampleProgress(
  cooperation: BusinessProgressCooperationSource,
  creatorId: string,
  samples: readonly BusinessProgressSampleSource[],
  packages: BusinessProgressSource["samplePackages"],
  tasks: readonly BusinessProgressTaskSource[],
  ownerKeyForId: (memberId: string | null) => string | null,
): BusinessProgressSampleProgress {
  const base = sampleProgress(cooperation, creatorId, samples, packages);
  const requests = base.requests.map((item) => {
    const sample = samples.find((row) => row.id === item.key);
    if (!sample) return item;
    const relatedTask = tasks.find((task) => task.status === "open" && task.relatedType === "sample" && task.relatedId === sample.id);
    if (!relatedTask) return item;
    return { ...item, nextAction: actionFromTask(relatedTask, ownerKeyForId) };
  });
  return { ...base, requests };
}

function actionFromTask(
  task: BusinessProgressTaskSource,
  ownerKeyForId: (memberId: string | null) => string | null,
): BusinessProgressNextAction {
  const code: BusinessProgressActionCode = task.kind === "followup" ? "log_followup"
    : task.kind === "sample_approval" ? "approve_sample_request"
      : task.kind === "sample_shipment" ? "ship_samples"
        : task.kind === "sample_receipt" ? "confirm_sample_receipt"
          : task.kind === "cooperation_approval" ? "review_cooperation"
              : task.kind === "schedule" ? "confirm_live_status"
              : task.kind === "delivery_review" ? "review_delivery"
                : "inspect_record";
  return {
    state: "task", code, ownerKey: ownerKeyForId(task.ownerMemberId), dueAt: task.dueAt,
    taskKind: task.kind, requiredCapability: task.requiredCapability,
  };
}

function taskOrder(left: BusinessProgressTaskSource, right: BusinessProgressTaskSource): number {
  const priority = { high: 0, normal: 1, low: 2 } as const;
  const priorityDifference = priority[left.priority] - priority[right.priority];
  if (priorityDifference !== 0) return priorityDifference;
  const leftDue = timestamp(left.dueAt) ?? Number.POSITIVE_INFINITY;
  const rightDue = timestamp(right.dueAt) ?? Number.POSITIVE_INFINITY;
  return leftDue - rightDue || left.id.localeCompare(right.id);
}

function taskAction(
  tasks: readonly BusinessProgressTaskSource[],
  ownerKeyForId: (memberId: string | null) => string | null,
): BusinessProgressNextAction | null {
  const task = tasks.filter((item) => item.status === "open").slice().sort(taskOrder)[0];
  return task ? actionFromTask(task, ownerKeyForId) : null;
}

function suggestedAction(code: BusinessProgressActionCode, dueAt: string | null = null): BusinessProgressNextAction {
  return { state: "suggested", code, ownerKey: null, dueAt, taskKind: null, requiredCapability: null };
}

function unregisteredAction(code: BusinessProgressActionCode = "inspect_record"): BusinessProgressNextAction {
  return { state: "unregistered", code, ownerKey: null, dueAt: null, taskKind: null, requiredCapability: null };
}

function noAction(): BusinessProgressNextAction {
  return { state: "none", code: "none", ownerKey: null, dueAt: null, taskKind: null, requiredCapability: null };
}

function creatorNextAction(
  creator: BusinessProgressCreatorSource,
  familyIds: ReadonlySet<string>,
  workItems: readonly BusinessProgressCooperationWorkItem[],
  tasks: readonly BusinessProgressTaskSource[],
  ownerKeyForId: (memberId: string | null) => string | null,
): BusinessProgressNextAction {
  const creatorTasks = tasks.filter((task) => task.relatedType === "creator"
    && task.relatedId !== null && familyIds.has(task.relatedId));
  const action = taskAction(creatorTasks, ownerKeyForId);
  if (action) return action;
  if (creator.crmStage === "declined") return noAction();
  if (creator.crmStage === "paused") {
    return creator.reviewAt ? suggestedAction("review_paused_creator", creator.reviewAt) : unregisteredAction();
  }
  if (workItems.some((item) => !["delivered", "cancelled", "rejected"].includes(item.status))) return noAction();
  return suggestedAction("log_followup");
}

function workItemNextAction(
  cooperation: BusinessProgressCooperationSource,
  sampleProgressValue: BusinessProgressSampleProgress,
  scheduleProgressValue: BusinessProgressCooperationWorkItem["scheduleProgress"],
  deliveryProgressValue: BusinessProgressDeliveryProgress,
  schedules: readonly BusinessProgressSource["schedules"][number][],
  deliveries: readonly BusinessProgressSource["deliveries"][number][],
  tasks: readonly BusinessProgressTaskSource[],
  ownerKeyForId: (memberId: string | null) => string | null,
): BusinessProgressNextAction {
  const sampleIds = new Set(sampleProgressValue.requests.map((sample) => sample.key));
  const scheduleIds = new Set(schedules.filter((item) => item.cooperationId === cooperation.id).map((item) => item.id));
  const deliveryIds = new Set(deliveries.filter((item) => item.cooperationId === cooperation.id).map((item) => item.id));
  const relevantTasks = tasks.filter((task) =>
    (task.relatedType === "cooperation" && task.relatedId === cooperation.id)
    || (task.relatedType === "sample" && task.relatedId !== null && sampleIds.has(task.relatedId))
    || (task.relatedType === "schedule" && task.relatedId !== null && scheduleIds.has(task.relatedId))
    || (task.relatedType === "delivery" && task.relatedId !== null && deliveryIds.has(task.relatedId)),
  );
  const taskActionValue = taskAction(relevantTasks, ownerKeyForId);
  if (taskActionValue) return taskActionValue;
  if (cooperation.status === "delivered" || cooperation.status === "cancelled" || cooperation.status === "rejected") return noAction();
  if (cooperation.status === "draft") return suggestedAction("submit_cooperation");
  if (cooperation.status === "pending_approval") return suggestedAction("review_cooperation");
  if (sampleProgressValue.state === "incomplete_data") return unregisteredAction();
  if (cooperation.status === "pending_samples_shipment") {
    if (sampleProgressValue.state === "awaiting_request") return suggestedAction("create_sample_request");
    if (sampleProgressValue.state === "pending_approval") return suggestedAction("approve_sample_request");
    if (["pending_shipment", "partially_shipped", "closed", "rejected"].includes(sampleProgressValue.state)) return suggestedAction("ship_samples");
    return unregisteredAction();
  }
  if (cooperation.status === "pending_samples_receipt") {
    if (["partially_shipped", "pending_shipment"].includes(sampleProgressValue.state)) return suggestedAction("ship_samples");
    if (["shipped", "partially_received"].includes(sampleProgressValue.state)) return suggestedAction("confirm_sample_receipt");
    return unregisteredAction();
  }
  if (cooperation.status === "pending_delivery") {
    for (const deliveryType of ["live", "short_video", "other"] as const) {
      const count = deliveryProgressValue.byType.find((item) => item.deliveryType === deliveryType);
      if (!count) continue;
      if (count.pendingReviewCount > 0) return suggestedAction("review_delivery");
      if (count.pendingSubmissionCount > 0 || count.returnedCount > 0) {
        return suggestedAction(deliveryType === "live" ? "submit_live_delivery" : deliveryType === "short_video" ? "submit_short_video_delivery" : "create_delivery");
      }
    }
    if (scheduleProgressValue.next?.timing === "overdue") return suggestedAction("confirm_live_status");
    if (deliveries.length === 0 && schedules.length === 0) return unregisteredAction("create_delivery");
    return unregisteredAction();
  }
  return unregisteredAction();
}

function scheduleTiming(
  schedule: BusinessProgressSource["schedules"][number],
  cutoff: number,
): "upcoming" | "in_window" | "overdue" | "unknown" {
  const start = timestamp(schedule.plannedStartAt);
  const end = timestamp(schedule.plannedEndAt);
  if (start === null || end === null || end <= start) return "unknown";
  if (end < cutoff) return "overdue";
  return start > cutoff ? "upcoming" : "in_window";
}

function scheduleProgress(
  cooperationId: string,
  schedules: readonly BusinessProgressSource["schedules"][number][],
  cutoff: number,
): BusinessProgressCooperationWorkItem["scheduleProgress"] {
  const related = schedules.filter((item) => item.cooperationId === cooperationId);
  const active = related.filter((item) => item.status === "planned" || item.status === "rescheduled");
  const sortedActive = active.slice().sort((left, right) =>
    (timestamp(left.plannedStartAt) ?? Number.POSITIVE_INFINITY) - (timestamp(right.plannedStartAt) ?? Number.POSITIVE_INFINITY)
    || left.id.localeCompare(right.id),
  );
  const next = sortedActive[0];
  const completed = related.filter((item) => item.status === "completed" && (timestamp(item.updatedAt) ?? Number.POSITIVE_INFINITY) <= cutoff);
  const latestCompletion = completed
    .filter((item) => item.actualStartAt !== null && item.actualEndAt !== null
      && timestamp(item.actualStartAt) !== null && timestamp(item.actualEndAt) !== null
      && timestamp(item.actualStartAt)! <= cutoff && timestamp(item.actualEndAt)! <= cutoff)
    .slice()
    .sort((left, right) => (timestamp(right.actualEndAt) ?? 0) - (timestamp(left.actualEndAt) ?? 0))[0];
  return {
    next: next ? {
      key: next.id,
      status: next.status as "planned" | "rescheduled",
      plannedStartAt: next.plannedStartAt,
      plannedEndAt: next.plannedEndAt,
      timing: scheduleTiming(next, cutoff),
    } : null,
    overdueCount: active.filter((item) => scheduleTiming(item, cutoff) === "overdue").length,
    cancelledCount: related.filter((item) => item.status === "cancelled").length,
    completionRecordedCount: completed.length,
    completionMissingActualTimeCount: completed.filter((item) => timestamp(item.actualStartAt) === null || timestamp(item.actualEndAt) === null).length,
    latestRecordedCompletion: latestCompletion ? {
      actualStartAt: latestCompletion.actualStartAt!,
      actualEndAt: latestCompletion.actualEndAt!,
    } : null,
  };
}

function deliveryProgress(
  cooperationId: string,
  deliveries: readonly BusinessProgressSource["deliveries"][number][],
): BusinessProgressDeliveryProgress {
  const requiredDeliveries = deliveries.filter((item) => item.cooperationId === cooperationId && item.required);
  const byType = DELIVERY_TYPES.map((deliveryType): BusinessProgressDeliveryCount => {
    const relevant = requiredDeliveries.filter((item) => item.type === deliveryType);
    return {
      deliveryType,
      requiredCount: relevant.length,
      pendingSubmissionCount: relevant.filter((item) => item.status === "pending_submission").length,
      pendingReviewCount: relevant.filter((item) => item.status === "pending_review").length,
      returnedCount: relevant.filter((item) => item.status === "returned").length,
      approvedCount: relevant.filter((item) => item.status === "approved").length,
      cancelledCount: relevant.filter((item) => item.status === "cancelled").length,
    };
  }).filter((item) => item.requiredCount > 0);
  return {
    byType,
    hasApprovedLiveDelivery: requiredDeliveries.some((item) => item.type === "live" && item.status === "approved"),
  };
}

function cooperationPlatforms(
  cooperation: BusinessProgressCooperationSource,
  schedules: readonly BusinessProgressSource["schedules"][number][],
  samples: readonly BusinessProgressSampleSource[],
): Platform[] {
  return [...new Set([
    ...cooperation.lines.flatMap((line) => line.platform ? [line.platform] : []),
    ...schedules.filter((item) => item.cooperationId === cooperation.id).map((item) => item.platform),
    ...samples.filter((item) => item.cooperationId === cooperation.id && item.platform).map((item) => item.platform!),
  ])].sort();
}

function cooperationProducts(
  cooperation: BusinessProgressCooperationSource,
  productsById: ReadonlyMap<string, BusinessProgressSource["products"][number]>,
): { products: Array<{ key: string; name: string; platform: Platform | null }>; unresolvedProductLineCount: number } {
  const products = new Map<string, { key: string; name: string; platform: Platform | null }>();
  let unresolvedProductLineCount = 0;
  for (const line of cooperation.lines) {
    if (!line.productId) {
      unresolvedProductLineCount += 1;
      continue;
    }
    const product = productsById.get(line.productId);
    if (!product) {
      unresolvedProductLineCount += 1;
      continue;
    }
    const current = products.get(product.id);
    if (current) {
      if (line.platform && !current.platform) current.platform = line.platform;
    } else {
      products.set(product.id, { key: product.id, name: product.name, platform: line.platform });
    }
  }
  return { products: [...products.values()], unresolvedProductLineCount };
}

function refundNaturalKey(refund: BusinessProgressSource["refunds"][number]): string {
  const refundId = refund.externalRefundId.trim();
  return refundId ? `${refund.platform}\0${refund.shopId?.trim() ?? ""}\0${refundId}` : `id:${refund.id}`;
}

function sameRefundFacts(
  left: BusinessProgressSource["refunds"][number],
  right: BusinessProgressSource["refunds"][number],
): boolean {
  return left.orderLineId === right.orderLineId
    && left.refundedAt === right.refundedAt
    && left.status === right.status
    && left.amountCents === right.amountCents
    && left.direction === right.direction;
}

function uniqueRefunds(refunds: readonly BusinessProgressSource["refunds"][number][]): {
  refunds: BusinessProgressSource["refunds"];
  conflicts: BusinessProgressSource["refunds"];
} {
  const byKey = new Map<string, BusinessProgressSource["refunds"][number]>();
  const conflicts: BusinessProgressSource["refunds"] = [];
  const conflictKeys = new Set<string>();
  for (const refund of refunds) {
    const key = refundNaturalKey(refund);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, refund);
      continue;
    }
    if (sameRefundFacts(existing, refund)) continue;
    if (!conflictKeys.has(key)) {
      conflicts.push(existing);
      conflictKeys.add(key);
    }
    conflicts.push(refund);
  }
  return {
    refunds: [...byKey.entries()].filter(([key]) => !conflictKeys.has(key)).map(([, refund]) => refund),
    conflicts,
  };
}

function makeSalesEntry(input: BusinessProgressSalesEntry): BusinessProgressSalesEntry {
  return input;
}

function addUnattributedPaidOrder(
  output: BusinessProgressWorkspace["unattributedSales"],
  order: BusinessProgressOrderSource,
  cutoff: number,
): void {
  if (order.status !== "paid") return;
  const paidAt = timestamp(order.paidAt);
  if (paidAt !== null && paidAt > cutoff) return;
  output.paidOrderLineCount += 1;
  if (paidAt === null) output.unknownPaidAtOrderLineCount += 1;
  if (order.paidAmountCents === null || !Number.isSafeInteger(order.paidAmountCents) || order.paidAmountCents < 0) {
    output.unknownOrderAmountCount += 1;
    return;
  }
  const total = addSafeCents(output.knownGrossCents, order.paidAmountCents);
  if (total === null) {
    output.unknownOrderAmountCount += 1;
    return;
  }
  output.knownGrossCents = total;
}

function addOrderToSales(
  sales: SaleAmountAccumulator,
  order: BusinessProgressOrderSource,
  ownerKey: string | null,
  cutoff: number,
): boolean {
  if (order.status !== "paid") return false;
  const paidAt = timestamp(order.paidAt);
  if (paidAt !== null && paidAt > cutoff) return false;
  const orderKey = orderNaturalKey(order);
  if (sales.orderKeys.has(orderKey)) return false;
  sales.orderKeys.add(orderKey);
  sales.paidOrderLineCount += 1;
  const owner = ownerSalesFor(sales, ownerKey);
  owner.paidOrderLineCount += 1;
  if (paidAt === null) {
    sales.unknownPaidAtOrderLineCount += 1;
    owner.unknownPaidAtOrderLineCount += 1;
  }
  addGross(sales, owner, order.paidAmountCents);
  return true;
}

function addRefundToSales(
  sales: SaleAmountAccumulator,
  refund: BusinessProgressSource["refunds"][number],
  ownerKey: string | null,
  cutoff: number,
): void {
  if (refund.status !== "succeeded") return;
  const refundedAt = timestamp(refund.refundedAt);
  if (refundedAt !== null && refundedAt > cutoff) return;
  const refundKey = refundNaturalKey(refund);
  if (sales.refundKeys.has(refundKey)) return;
  sales.refundKeys.add(refundKey);
  sales.succeededRefundCount += 1;
  const owner = ownerSalesFor(sales, ownerKey);
  if (refundedAt === null) {
    sales.unknownRefundDateCount += 1;
    owner.unknownRefundDateCount += 1;
  }
  if (refund.amountCents === null || !Number.isSafeInteger(refund.amountCents) || refund.amountCents < 0) {
    sales.unknownRefundAmountCount += 1;
    owner.unknownRefundAmountCount += 1;
    return;
  }
  const signedRefund = refund.direction === "refund" ? refund.amountCents : -refund.amountCents;
  const total = addSafeCents(sales.knownRefundCents, signedRefund);
  const ownerTotal = addSafeCents(owner.knownRefundCents, signedRefund);
  if (total === null || ownerTotal === null) {
    sales.unknownRefundAmountCount += 1;
    owner.unknownRefundAmountCount += 1;
    return;
  }
  sales.knownRefundCents = total;
  owner.knownRefundCents = ownerTotal;
}

function finishSales(sales: SaleAmountAccumulator, refundCoverage: BusinessProgressSource["refundCoverage"]): BusinessProgressCreatorSales {
  const knownNet = addSafeCents(sales.knownGrossCents, -sales.knownRefundCents);
  const netComplete = refundCoverage === "records_only"
    && sales.unknownOrderAmountCount === 0
    && sales.unknownPaidAtOrderLineCount === 0
    && sales.unknownRefundAmountCount === 0
    && sales.unknownRefundDateCount === 0
    && knownNet !== null;
  const byOwner = [...sales.byOwner.values()].map((owner) => {
    const net = addSafeCents(owner.knownGrossCents, -owner.knownRefundCents);
    return {
      ...owner,
      knownNetCents: net ?? 0,
      netComplete: refundCoverage === "records_only"
        && owner.unknownOrderAmountCount === 0
        && owner.unknownPaidAtOrderLineCount === 0
        && owner.unknownRefundAmountCount === 0
        && owner.unknownRefundDateCount === 0
        && net !== null,
    };
  }).sort((left, right) => (left.ownerKey ?? "").localeCompare(right.ownerKey ?? ""));
  return {
    paidOrderLineCount: sales.paidOrderLineCount,
    knownGrossCents: sales.knownGrossCents,
    unknownOrderAmountCount: sales.unknownOrderAmountCount,
    unknownPaidAtOrderLineCount: sales.unknownPaidAtOrderLineCount,
    succeededRefundCount: sales.succeededRefundCount,
    knownRefundCents: sales.knownRefundCents,
    unknownRefundAmountCount: sales.unknownRefundAmountCount,
    unknownRefundDateCount: sales.unknownRefundDateCount,
    knownNetCents: knownNet ?? 0,
    refundCoverage,
    netComplete,
    unassignedOrderLineCount: sales.byOwner.get("__unknown_owner__")?.paidOrderLineCount ?? 0,
    byOwner,
    manualReports: [],
    historicalManualSessionCount: 0,
  };
}

function mutableManualOwner(rows: Map<string, BusinessProgressManualSalesByOwner>, ownerKey: string | null): BusinessProgressManualSalesByOwner {
  const key = ownerKey ?? "__unknown_owner__";
  let row = rows.get(key);
  if (!row) {
    row = { ownerKey, reportCount: 0, countedCount: 0, countedGmvCents: 0, unreviewedCount: 0, returnedCount: 0, reconciliationRequiredCount: 0, replacedByOrdersCount: 0 };
    rows.set(key, row);
  }
  return row;
}

function addManualReport(
  rows: Map<string, BusinessProgressManualSalesByOwner>,
  report: BusinessProgressSource["salesReports"][number],
  accountingStatus: ReturnType<typeof accountingStatusForSalesReport>,
  ownerKey: string | null,
): void {
  const row = mutableManualOwner(rows, ownerKey);
  row.reportCount += 1;
  switch (accountingStatus) {
    case "counted":
      row.countedCount += 1;
      row.countedGmvCents = addSafeCents(row.countedGmvCents, report.gmvCents) ?? row.countedGmvCents;
      break;
    case "unreviewed": row.unreviewedCount += 1; break;
    case "returned": row.returnedCount += 1; break;
    case "reconciliation_required": row.reconciliationRequiredCount += 1; break;
    case "replaced_by_orders": row.replacedByOrdersCount += 1; break;
  }
}

function creatorGroup(
  creatorId: string,
  creatorsById: ReadonlyMap<string, BusinessProgressCreatorSource>,
): Set<string> {
  return new Set([...creatorsById.keys()].filter((id) => canonicalCreatorId(id, creatorsById) === creatorId));
}

/**
 * Pure, manager-facing projection. The keyed owner secret is server-only and is never returned.
 */
export function buildBusinessProgress(
  source: BusinessProgressSource,
  observedAt: string,
  ownerKeySecret: string,
): BusinessProgressWorkspace {
  const cutoff = timestamp(observedAt);
  if (cutoff === null) throw new RangeError("business progress observedAt must be a valid ISO timestamp");
  if (Buffer.byteLength(ownerKeySecret, "utf8") < 32) throw new RangeError("business progress owner key secret must be at least 32 bytes");
  const observedOn = dateAtShanghai(observedAt);
  const teamIds = new Set(source.teamIds);
  const inScope = <T extends { orgId: string; teamId: string }>(items: readonly T[]): T[] => items.filter((item) => scopeMatches(item, source, teamIds));
  const members = inScope(source.members);
  const ownerMemberById = new Map<string, VisibleOwner>();
  for (const member of members) {
    const existing = ownerMemberById.get(member.id);
    if (existing && existing.teamId !== member.teamId) {
      ownerMemberById.delete(member.id);
      continue;
    }
    if (!ownerMemberById.has(member.id)) {
      ownerMemberById.set(member.id, {
        key: makeOwnerKey(ownerKeySecret, source.orgId, member.teamId, member.id),
        displayName: member.displayName.trim() || "未命名成员",
        teamId: member.teamId,
        active: member.active,
      });
    }
  }
  const ownerKeyForId = (memberId: string | null): string | null => memberId ? ownerMemberById.get(memberId)?.key ?? null : null;
  const creatorSources = inScope(source.creators);
  const creatorsById = new Map(creatorSources.map((creator) => [creator.id, creator]));
  const roots = creatorSources.filter((creator) => !creator.archived
    && creator.mergedIntoCreatorId === null
    && canonicalCreatorId(creator.id, creatorsById) === creator.id)
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN") || left.id.localeCompare(right.id));
  const stageEvents = inScope(source.stageEvents);
  const followups = inScope(source.followups);
  const tasks = inScope(source.tasks);
  const cooperations = inScope(source.cooperations);
  const samples = inScope(source.samples);
  const packages = inScope(source.samplePackages);
  const schedules = inScope(source.schedules);
  const deliveries = inScope(source.deliveries);
  const ordersInput = inScope(source.orders);
  const overlapOrders = source.overlapOrders.filter((order) => order.orgId === source.orgId);
  const refundsInput = inScope(source.refunds);
  const corrections = inScope(source.ownerCorrections);
  const salesReports = inScope(source.salesReports);
  const sessions = inScope(source.creatorSessions);
  const productsById = new Map(inScope(source.products).map((item) => [item.id, item]));
  const deduplicatedOrders = uniqueOrders(ordersInput);
  const creatorOrderCandidates = new Map<string, Set<string>>();
  const attributionCreators = creatorSources.map((creator) => ({
    id: creator.id,
    mergedIntoCreatorId: creator.mergedIntoCreatorId,
    accounts: creator.accounts.map((account) => ({ platform: account.platform, externalAccountId: account.externalAccountId })),
  }));
  for (const creator of roots) {
    const attribution = creatorOrderAttribution(creator.id, attributionCreators, deduplicatedOrders.orders);
    for (const order of attribution.orders) {
      const candidateSet = creatorOrderCandidates.get(order.id) ?? new Set<string>();
      candidateSet.add(creator.id);
      creatorOrderCandidates.set(order.id, candidateSet);
    }
  }
  const uniqueRootForOrderId = new Map<string, string>();
  for (const order of deduplicatedOrders.orders) {
    const candidates = creatorOrderCandidates.get(order.id);
    if (candidates?.size === 1) uniqueRootForOrderId.set(order.id, [...candidates][0]!);
  }

  const salesByCreator = new Map<string, SaleAmountAccumulator>(roots.map((creator) => [creator.id, blankSales()]));
  const orderByAnyId = new Map<string, BusinessProgressOrderSource>();
  const rootByAnyOrderId = new Map<string, string | null>();
  const ownerByAnyOrderId = new Map<string, string | null>();
  const ownerBasisByAnyOrderId = new Map<string, BusinessProgressSalesEntry["ownerBasis"]>();
  const output: BusinessProgressWorkspace = {
    observedAt,
    observedOn,
    owners: [],
    ownerDirectory: [],
    creatorRelations: [],
    unassignedCreatorKeys: [],
    salesEntries: [],
    unattributedSales: {
      paidOrderLineCount: 0,
      knownGrossCents: 0,
      unknownOrderAmountCount: 0,
      unknownPaidAtOrderLineCount: 0,
      unknownRefundDateCount: 0,
      manualReportCount: 0,
      countedManualGmvCents: 0,
      duplicateConflictCount: 0,
    },
  };
  const duplicateConflictKeys = new Set(deduplicatedOrders.conflicts.map(orderNaturalKey));
  output.unattributedSales.duplicateConflictCount += duplicateConflictKeys.size;
  const emittedConflictKeys = new Set<string>();
  for (const conflict of deduplicatedOrders.conflicts) {
    const key = orderNaturalKey(conflict);
    if (emittedConflictKeys.has(key)) continue;
    emittedConflictKeys.add(key);
    addUnattributedPaidOrder(output.unattributedSales, { ...conflict, paidAmountCents: null }, cutoff);
    output.salesEntries.push(makeSalesEntry({
      kind: "order", sourceKey: conflict.id, creatorKey: null, ownerKey: null,
      ownerBasis: "unknown",
      platform: conflict.platform, date: null, occurredAt: null, amountCents: null, status: "unknown",
      accountingStatus: null, refundDirection: null,
    }));
  }

  const aliasIdsByPrimaryId = new Map(deduplicatedOrders.aliasesByOrderId);
  for (const [primaryId, aliases] of aliasIdsByPrimaryId) {
    const primary = deduplicatedOrders.orders.find((order) => order.id === primaryId);
    if (!primary) continue;
    const rootId = uniqueRootForOrderId.get(primary.id) ?? null;
    const ownerMemberId = primary.status === "paid" ? resolveOrderOwner(primary, corrections) : null;
    const ownerKey = ownerKeyForId(ownerMemberId);
    const ownerBasis = orderOwnerBasis(primary, corrections, ownerKey);
    for (const aliasId of aliases) {
      orderByAnyId.set(aliasId, primary);
      rootByAnyOrderId.set(aliasId, rootId);
      ownerByAnyOrderId.set(aliasId, ownerKey);
      ownerBasisByAnyOrderId.set(aliasId, ownerBasis);
    }
    const paidAtMs = timestamp(primary.paidAt);
    const isFuturePaid = primary.status === "paid" && paidAtMs !== null && paidAtMs > cutoff;
    if (isFuturePaid) continue;
    if (primary.status === "paid" && rootId === null) addUnattributedPaidOrder(output.unattributedSales, primary, cutoff);
    if (rootId !== null) {
      const sales = salesByCreator.get(rootId);
      if (sales) addOrderToSales(sales, primary, ownerKey, cutoff);
    }
    output.salesEntries.push(makeSalesEntry({
      kind: "order",
      sourceKey: primary.id,
      creatorKey: rootId,
      ownerKey: primary.status === "paid" ? ownerKey : null,
      ownerBasis: primary.status === "paid" ? ownerBasis : "not_applicable",
      platform: primary.platform,
      date: primary.status === "paid" && paidAtMs !== null ? dateAtShanghai(primary.paidAt!) as BusinessProgressSalesEntry["date"] : null,
      occurredAt: primary.status === "paid" && paidAtMs !== null ? primary.paidAt : null,
      amountCents: primary.status === "paid" ? primary.paidAmountCents : null,
      status: primary.status,
      accountingStatus: null,
      refundDirection: null,
    }));
  }

  const uniqueRefundResult = uniqueRefunds(refundsInput);
  const conflictRefundKeys = new Set(uniqueRefundResult.conflicts.map(refundNaturalKey));
  output.unattributedSales.duplicateConflictCount += conflictRefundKeys.size;
  const emittedRefundConflictKeys = new Set<string>();
  for (const conflict of uniqueRefundResult.conflicts) {
    const key = refundNaturalKey(conflict);
    if (emittedRefundConflictKeys.has(key)) continue;
    emittedRefundConflictKeys.add(key);
    const order = orderByAnyId.get(conflict.orderLineId);
    const rootId = rootByAnyOrderId.get(conflict.orderLineId) ?? null;
    const ownerKey = ownerByAnyOrderId.get(conflict.orderLineId) ?? null;
    const ownerBasis = ownerBasisByAnyOrderId.get(conflict.orderLineId) ?? "unknown";
    if (conflict.status === "succeeded" && rootId !== null) {
      const sales = salesByCreator.get(rootId);
      if (sales) addRefundToSales(sales, { ...conflict, amountCents: null }, ownerKey, cutoff);
    } else if (conflict.status === "succeeded" && rootId === null && timestamp(conflict.refundedAt) === null) {
      output.unattributedSales.unknownRefundDateCount += 1;
    }
    output.salesEntries.push(makeSalesEntry({
      kind: "refund", sourceKey: conflict.id, creatorKey: rootId,
      ownerKey: order ? ownerKey : null, ownerBasis: order ? ownerBasis : "unknown", platform: conflict.platform,
      date: null, occurredAt: null, amountCents: null, status: "unknown",
      accountingStatus: null, refundDirection: null,
    }));
  }
  for (const refund of uniqueRefundResult.refunds) {
    const refundedAtMs = timestamp(refund.refundedAt);
    if (refundedAtMs !== null && refundedAtMs > cutoff) continue;
    const order = orderByAnyId.get(refund.orderLineId);
    const rootId = rootByAnyOrderId.get(refund.orderLineId) ?? null;
    const ownerKey = ownerByAnyOrderId.get(refund.orderLineId) ?? null;
    const ownerBasis = ownerBasisByAnyOrderId.get(refund.orderLineId) ?? "unknown";
    if (refund.status === "succeeded" && rootId !== null && order?.status === "paid") {
      const sales = salesByCreator.get(rootId);
      if (sales) addRefundToSales(sales, refund, ownerKey, cutoff);
    } else if (refund.status === "succeeded" && rootId === null && refundedAtMs === null) {
      output.unattributedSales.unknownRefundDateCount += 1;
    }
    output.salesEntries.push(makeSalesEntry({
      kind: "refund", sourceKey: refund.id, creatorKey: rootId,
      ownerKey: order ? ownerKey : null,
      ownerBasis: order ? ownerBasis : refund.status === "succeeded" ? "unknown" : "not_applicable",
      platform: refund.platform,
      date: refundedAtMs !== null ? dateAtShanghai(refund.refundedAt!) as BusinessProgressSalesEntry["date"] : null,
      occurredAt: refundedAtMs !== null ? refund.refundedAt : null,
      amountCents: refund.status === "succeeded" ? refund.amountCents : null,
      status: refund.status,
      accountingStatus: null,
      refundDirection: refund.direction,
    }));
  }

  const manualByCreator = new Map<string, Map<string, BusinessProgressManualSalesByOwner>>();
  const scopedReports = salesReports.filter((report) => report.creditedOn <= observedOn);
  for (const report of scopedReports) {
    // Reconcile against the complete in-scope brand order set before grouping by creator or owner.
    const overlaps = findPotentialOrderOverlaps(report, overlapOrders).length;
    const accountingStatus = accountingStatusForSalesReport(report, overlaps);
    const rootId = creatorsById.has(report.creatorId) ? canonicalCreatorId(report.creatorId, creatorsById) : null;
    const ownerKey = ownerKeyForId(report.ownerMemberId);
    if (rootId && salesByCreator.has(rootId)) {
      const rows = manualByCreator.get(rootId) ?? new Map<string, BusinessProgressManualSalesByOwner>();
      addManualReport(rows, report, accountingStatus, ownerKey);
      manualByCreator.set(rootId, rows);
    } else {
      output.unattributedSales.manualReportCount += 1;
      if (accountingStatus === "counted") {
        output.unattributedSales.countedManualGmvCents = addSafeCents(output.unattributedSales.countedManualGmvCents, report.gmvCents)
          ?? output.unattributedSales.countedManualGmvCents;
      }
    }
    output.salesEntries.push(makeSalesEntry({
      kind: "manual", sourceKey: report.id, creatorKey: rootId,
      ownerKey, ownerBasis: ownerKey ? "report_owner" : "unknown", platform: report.platform, date: report.creditedOn as BusinessProgressSalesEntry["date"],
      occurredAt: null, amountCents: accountingStatus === "counted" ? report.gmvCents : null, status: report.status,
      accountingStatus, refundDirection: null,
    }));
  }

  const sessionCounts = new Map<string, number>();
  for (const session of sessions) {
    if (session.occurredOn > observedOn) continue;
    const rootId = creatorsById.has(session.creatorId) ? canonicalCreatorId(session.creatorId, creatorsById) : null;
    if (rootId && salesByCreator.has(rootId)) sessionCounts.set(rootId, (sessionCounts.get(rootId) ?? 0) + 1);
  }

  const visibleCooperations = cooperations;
  const memberIdentityByKey = new Map([...ownerMemberById.values()].map((member) => [member.key, member]));
  const ownerGroups = new Map<string, BusinessProgressOwner>();
  const unassignedCreatorKeys: string[] = [];
  const addOwnerLink = (
    owner: VisibleOwner,
    creatorKey: string,
    relation: "current" | "cooperation",
    workItemKeys: string[],
  ): void => {
    const group = ownerGroups.get(owner.key) ?? { key: owner.key, displayName: owner.displayName, active: owner.active, kind: "work_owner" as const, creatorLinks: [] };
    const existing = group.creatorLinks.find((link) => link.creatorKey === creatorKey && link.relation === relation);
    if (existing) existing.workItemKeys = [...new Set([...existing.workItemKeys, ...workItemKeys])];
    else group.creatorLinks.push({ creatorKey, relation, workItemKeys: [...new Set(workItemKeys)] });
    ownerGroups.set(owner.key, group);
  };
  for (const creator of roots) {
    const familyIds = creatorGroup(creator.id, creatorsById);
    const currentOwnerKey = ownerKeyForId(creator.ownerMemberId);
    const creatorWorkItems = visibleCooperations
      .filter((item) => familyIds.has(item.creatorId))
      .sort((left, right) => left.title.localeCompare(right.title, "zh-CN") || left.id.localeCompare(right.id))
      .map((cooperation) => {
        const cooperativeSampleProgress = buildSampleProgress(cooperation, creator.id, samples, packages, tasks, ownerKeyForId);
        const schedule = scheduleProgress(cooperation.id, schedules, cutoff);
        const delivery = deliveryProgress(cooperation.id, deliveries);
        const relatedSchedules = schedules.filter((item) => item.cooperationId === cooperation.id);
        const relatedDeliveries = deliveries.filter((item) => item.cooperationId === cooperation.id);
        const workItemTasks = tasks.filter((task) => {
          if (task.relatedType === "cooperation" && task.relatedId === cooperation.id) return true;
          if (task.relatedType === "sample" && task.relatedId !== null && cooperativeSampleProgress.requests.some((request) => request.key === task.relatedId)) return true;
          if (task.relatedType === "schedule" && task.relatedId !== null && relatedSchedules.some((item) => item.id === task.relatedId)) return true;
          return task.relatedType === "delivery" && task.relatedId !== null && relatedDeliveries.some((item) => item.id === task.relatedId);
        });
        const cooperationOwnerKey = ownerKeyForId(cooperation.ownerMemberId);
        const productProjection = cooperationProducts(cooperation, productsById);
        return {
          key: cooperation.id,
          title: cooperation.title,
          cooperationOwnerKey,
          platforms: cooperationPlatforms(cooperation, schedules, samples),
          products: productProjection.products,
          unresolvedProductLineCount: productProjection.unresolvedProductLineCount,
          status: cooperation.status,
          updatedAt: cooperation.updatedAt,
          sampleProgress: cooperativeSampleProgress,
          scheduleProgress: schedule,
          deliveryProgress: delivery,
          nextAction: taskAction(workItemTasks, ownerKeyForId)
            ?? workItemNextAction(cooperation, cooperativeSampleProgress, schedule, delivery, schedules, deliveries, tasks, ownerKeyForId),
          salesAttribution: "creator_summary_only" as const,
        };
      });
    const requiredForCooperations = new Set(visibleCooperations.filter((item) => familyIds.has(item.creatorId)).flatMap((item) => item.requiredSampleIds));
    const directSampleRows = samples.filter((sample) => familyIds.has(sample.creatorId)
      && sample.cooperationId === null && !requiredForCooperations.has(sample.id))
      .map((sample) => {
        const view = sampleRequestView(sample, packages, true);
        const task = tasks.filter((item) => item.status === "open" && item.relatedType === "sample" && item.relatedId === sample.id).sort(taskOrder)[0];
        return task ? { ...view, nextAction: actionFromTask(task, ownerKeyForId) } : view;
      });
    const latestFollowup = latestAtOrBefore(
      followups.filter((item) => familyIds.has(item.creatorId)).map((item) => item.occurredAt),
      cutoff,
    );
    const currentStageEventAt = latestAtOrBefore(
      stageEvents.filter((item) => familyIds.has(item.creatorId) && item.stage === creator.crmStage).map((item) => item.occurredAt),
      cutoff,
    );
    const relatedSessions = sessionCounts.get(creator.id) ?? 0;
    const creatorSales = finishSales(salesByCreator.get(creator.id) ?? blankSales(), source.refundCoverage);
    creatorSales.manualReports = [...(manualByCreator.get(creator.id)?.values() ?? [])]
      .sort((left, right) => (left.ownerKey ?? "").localeCompare(right.ownerKey ?? ""));
    creatorSales.historicalManualSessionCount = relatedSessions;
    const creatorPlatforms = [...new Set(creator.accounts.map((account) => account.platform))].sort();
    const nextAction = creatorNextAction(creator, familyIds, creatorWorkItems, tasks, ownerKeyForId);
    const progressCreator: BusinessProgressCreator = {
      key: creator.id,
      name: creator.name,
      currentOwnerKey,
      platforms: creatorPlatforms,
      crmStage: creator.crmStage,
      crmStageAt: currentStageEventAt,
      lastFollowupAt: latestFollowup,
      nextAction,
      workItems: creatorWorkItems,
      directSamples: directSampleRows,
      sales: creatorSales,
    };
    output.creatorRelations.push(progressCreator);
    if (currentOwnerKey === null) {
      unassignedCreatorKeys.push(creator.id);
    } else {
      const currentOwner = memberIdentityByKey.get(currentOwnerKey);
      if (currentOwner) addOwnerLink(currentOwner, creator.id, "current", []);
      else unassignedCreatorKeys.push(creator.id);
    }
    const workItemsByOwner = new Map<string, string[]>();
    for (const workItem of creatorWorkItems) {
      if (!workItem.cooperationOwnerKey) continue;
      const keys = workItemsByOwner.get(workItem.cooperationOwnerKey) ?? [];
      keys.push(workItem.key);
      workItemsByOwner.set(workItem.cooperationOwnerKey, keys);
    }
    for (const [ownerKey, workItemKeys] of workItemsByOwner) {
      const cooperationOwner = memberIdentityByKey.get(ownerKey);
      if (cooperationOwner) addOwnerLink(cooperationOwner, creator.id, "cooperation", workItemKeys);
    }
  }
  const ledgerOwnerKeys = new Set(output.salesEntries
    .filter((entry) => entry.kind === "order" || entry.kind === "refund")
    .flatMap((entry) => entry.ownerKey ? [entry.ownerKey] : []));
  const reportOwnerKeys = new Set(output.salesEntries
    .filter((entry) => entry.kind === "manual")
    .flatMap((entry) => entry.ownerKey ? [entry.ownerKey] : []));
  const salesOwnerKeys = new Set([...ledgerOwnerKeys, ...reportOwnerKeys]);
  for (const ownerKey of salesOwnerKeys) {
    if (ownerGroups.has(ownerKey)) continue;
    const salesOwner = memberIdentityByKey.get(ownerKey);
    if (!salesOwner) continue;
    ownerGroups.set(ownerKey, {
      key: ownerKey,
      displayName: salesOwner.displayName,
      active: salesOwner.active,
      kind: ledgerOwnerKeys.has(ownerKey) ? "sales_only" : "report_only",
      creatorLinks: [],
    });
  }
  output.owners = [...ownerGroups.values()].map((owner) => ({
    ...owner,
    kind: owner.creatorLinks.length > 0 ? "work_owner" as const : owner.kind,
    creatorLinks: owner.creatorLinks.sort((left, right) => left.creatorKey.localeCompare(right.creatorKey) || left.relation.localeCompare(right.relation)),
  })).sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-CN") || left.key.localeCompare(right.key));
  const referencedOwnerKeys = new Set<string>(output.owners.map((owner) => owner.key));
  const addActionOwner = (action: BusinessProgressNextAction): void => {
    if (action.ownerKey) referencedOwnerKeys.add(action.ownerKey);
  };
  for (const creator of output.creatorRelations) {
    if (creator.currentOwnerKey) referencedOwnerKeys.add(creator.currentOwnerKey);
    addActionOwner(creator.nextAction);
    for (const sample of creator.directSamples) addActionOwner(sample.nextAction);
    for (const workItem of creator.workItems) {
      if (workItem.cooperationOwnerKey) referencedOwnerKeys.add(workItem.cooperationOwnerKey);
      addActionOwner(workItem.nextAction);
      for (const sample of workItem.sampleProgress.requests) addActionOwner(sample.nextAction);
    }
  }
  for (const entry of output.salesEntries) {
    if (entry.ownerKey) referencedOwnerKeys.add(entry.ownerKey);
  }
  output.ownerDirectory = [...ownerMemberById.values()]
    .filter((member) => referencedOwnerKeys.has(member.key))
    .map(({ key, displayName, active }) => ({ key, displayName, active }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-CN") || left.key.localeCompare(right.key));
  output.creatorRelations.sort((left, right) => left.name.localeCompare(right.name, "zh-CN") || left.key.localeCompare(right.key));
  output.unassignedCreatorKeys = [...new Set(unassignedCreatorKeys)].sort();
  output.salesEntries.sort((left, right) => {
    const leftTime = timestamp(left.occurredAt) ?? (left.date ? Date.parse(`${left.date}T00:00:00+08:00`) : Number.NEGATIVE_INFINITY);
    const rightTime = timestamp(right.occurredAt) ?? (right.date ? Date.parse(`${right.date}T00:00:00+08:00`) : Number.NEGATIVE_INFINITY);
    return rightTime - leftTime || left.kind.localeCompare(right.kind) || left.sourceKey.localeCompare(right.sourceKey);
  });
  return output;
}
