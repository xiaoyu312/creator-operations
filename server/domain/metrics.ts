import {
  CRM_STAGES,
  COOPERATION_STATUSES,
  type CrmStage,
  type Creator,
  type CreatorStageEvent,
  type Delivery,
  type DomainState,
  type Id,
  type ImportBatch,
  type LiveSchedule,
  type OrderLine,
  type OwnerCorrection,
  type RefundEvent,
  type SamplePackage,
  type SampleRequest,
  type WorkTask,
  type WorkspaceFilters,
  type WorkspaceMetrics,
} from "../../shared/types.ts";
import { addCents } from "./utils.ts";

export interface MetricsInput {
  creators: Creator[];
  stageEvents: CreatorStageEvent[];
  samples: SampleRequest[];
  samplePackages: SamplePackage[];
  cooperations: DomainState["cooperations"];
  schedules: LiveSchedule[];
  deliveries: Delivery[];
  orders: OrderLine[];
  refunds: RefundEvent[];
  ownerCorrections: OwnerCorrection[];
  tasks: WorkTask[];
  importBatches: ImportBatch[];
  importHistoryVisible: boolean;
  includeSales: boolean;
}

export function shanghaiBounds(filters: Pick<WorkspaceFilters, "dateFrom" | "dateTo">): { start: number; end: number; from: string | null; to: string | null } {
  const start = filters.dateFrom ? new Date(`${filters.dateFrom}T00:00:00+08:00`).getTime() : Number.NEGATIVE_INFINITY;
  const end = filters.dateTo ? new Date(`${nextDate(filters.dateTo)}T00:00:00+08:00`).getTime() : Number.POSITIVE_INFINITY;
  return { start, end, from: filters.dateFrom ?? null, to: filters.dateTo ?? null };
}

function nextDate(day: string): string {
  const date = new Date(`${day}T00:00:00+08:00`);
  return new Date(date.getTime() + 24 * 60 * 60 * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

export function shanghaiDate(value: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

export function effectiveOwner(order: OrderLine, corrections: OwnerCorrection[]): Id | null {
  const latest = corrections
    .filter((item) => item.orderLineId === order.id)
    .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt) || b.id.localeCompare(a.id))[0];
  return latest ? latest.correctedMemberId : order.ownerSnapshot.memberId;
}

function inRange(timestamp: string | null, start: number, end: number): boolean {
  if (!timestamp) return false;
  const value = Date.parse(timestamp);
  return Number.isFinite(value) && value >= start && value < end;
}

function makeStageCounts(): Record<CrmStage, number> {
  return Object.fromEntries(CRM_STAGES.map((stage) => [stage, 0])) as Record<CrmStage, number>;
}

function makeCooperationCounts(): WorkspaceMetrics["cooperations"] {
  return Object.fromEntries(COOPERATION_STATUSES.map((status) => [status, 0])) as WorkspaceMetrics["cooperations"];
}

function signedRefund(refund: RefundEvent): number | null {
  if (refund.status !== "succeeded" || refund.amountCents === null) return null;
  const direction = refund.direction === "refund" ? 1 : -1;
  return direction * refund.amountCents;
}

export function calculateMetrics(input: MetricsInput, filters: WorkspaceFilters, now: string, observedThrough?: string): WorkspaceMetrics {
  const bounds = shanghaiBounds(filters);
  const nowMs = Date.parse(now);
  const reportCutoff = Number.isFinite(nowMs) ? nowMs : Date.now();
  const observedDate = observedThrough ?? shanghaiDate(now);
  const byStage = makeStageCounts();
  for (const creator of input.creators) byStage[creator.crmStage] += 1;

  const contactedByCreator = new Map<Id, number>();
  for (const event of input.stageEvents) {
    if (event.stage !== "contacted" || !Number.isFinite(Date.parse(event.occurredAt)) || Date.parse(event.occurredAt) > reportCutoff) continue;
    const previous = contactedByCreator.get(event.creatorId);
    if (previous === undefined || Date.parse(event.occurredAt) < previous) contactedByCreator.set(event.creatorId, Date.parse(event.occurredAt));
  }
  const cohort = input.creators.filter((creator) => {
    const firstTouch = contactedByCreator.get(creator.id);
    return firstTouch !== undefined && firstTouch >= bounds.start && firstTouch < bounds.end;
  });
  const cohortIds = new Set(cohort.map((creator) => creator.id));
  const reachedByCreator = new Map<Id, Set<CrmStage>>();
  for (const event of input.stageEvents) {
    if (!cohortIds.has(event.creatorId) || Date.parse(event.occurredAt) > reportCutoff) continue;
    const reached = reachedByCreator.get(event.creatorId) ?? new Set<CrmStage>();
    reached.add(event.stage);
    reachedByCreator.set(event.creatorId, reached);
  }
  const funnel = makeStageCounts();
  funnel.contacted = cohort.length;
  funnel.responded = cohort.filter((creator) => reachedByCreator.get(creator.id)?.has("contacted") && reachedByCreator.get(creator.id)?.has("responded")).length;
  funnel.negotiating = cohort.filter((creator) => reachedByCreator.get(creator.id)?.has("contacted") && reachedByCreator.get(creator.id)?.has("responded") && reachedByCreator.get(creator.id)?.has("negotiating")).length;
  funnel.cooperating = cohort.filter((creator) => reachedByCreator.get(creator.id)?.has("contacted") && reachedByCreator.get(creator.id)?.has("responded") && reachedByCreator.get(creator.id)?.has("negotiating") && reachedByCreator.get(creator.id)?.has("cooperating")).length;
  for (const stage of ["paused", "declined"] as const) {
    funnel[stage] = cohort.filter((creator) => reachedByCreator.get(creator.id)?.has(stage)).length;
  }

  const paidOrders = input.includeSales
    ? input.orders.filter((order) => order.status === "paid" && inRange(order.paidAt, bounds.start, bounds.end) && Date.parse(order.paidAt!) <= reportCutoff)
    : [];
  const paidAmount = paidOrders.reduce((total, order) => order.paidAmountCents === null ? total : addCents(total, order.paidAmountCents), 0);
  const paidUnknown = paidOrders.filter((order) => order.paidAmountCents === null).length;
  const unassigned = paidOrders.filter((order) => !effectiveOwner(order, input.ownerCorrections));
  const unassignedKnown = unassigned.reduce((total, order) => order.paidAmountCents === null ? total : addCents(total, order.paidAmountCents), 0);

  const activityRefunds = input.includeSales
    ? input.refunds.filter((refund) => refund.status === "succeeded" && inRange(refund.refundedAt, bounds.start, bounds.end) && Date.parse(refund.refundedAt!) <= reportCutoff)
    : [];
  let refundAmount = 0;
  let unknownRefundCount = 0;
  for (const refund of activityRefunds) {
    const signed = signedRefund(refund);
    if (signed === null) unknownRefundCount += 1;
    else refundAmount = addCents(refundAmount, signed);
  }

  let netAmount = 0;
  let netUnknownCount = 0;
  for (const order of paidOrders) {
    if (order.paidAmountCents === null) {
      netUnknownCount += 1;
      continue;
    }
    let net = order.paidAmountCents;
    let orderRefundUnknown = false;
    for (const refund of input.refunds) {
      if (refund.orderLineId !== order.id || refund.status !== "succeeded" || !refund.refundedAt || Date.parse(refund.refundedAt) > reportCutoff) continue;
      const signed = signedRefund(refund);
      if (signed === null) orderRefundUnknown = true;
      else net -= signed;
    }
    netAmount = addCents(netAmount, net);
    if (orderRefundUnknown) netUnknownCount += 1;
  }

  const deliveryDue = input.deliveries.filter((item) => item.required && item.status !== "cancelled" && inRange(item.dueAt, bounds.start, bounds.end) && Date.parse(item.dueAt) < reportCutoff);
  const deliveredOnTime = deliveryDue.filter((item) => {
    const lastApproval = item.reviews.filter((review) => review.decision === "approved").sort((a, b) => Date.parse(b.reviewedAt) - Date.parse(a.reviewedAt))[0];
    return item.status === "approved" && Boolean(lastApproval) && Date.parse(lastApproval.reviewedAt) <= reportCutoff && Date.parse(lastApproval.reviewedAt) <= Date.parse(item.dueAt);
  }).length;

  const openTasks = input.tasks.filter((task) => task.status === "open");
  const overdue = openTasks.filter((task) => task.dueAt !== null && Date.parse(task.dueAt) < nowMs);
  const withoutDeadlineCount = openTasks.filter((task) => task.dueAt === null).length;
  const overdueByOwner: Record<Id, number> = {};
  for (const task of overdue) {
    const ownerKey = task.ownerMemberId ?? `queue:${task.requiredCapability ?? "unassigned"}`;
    overdueByOwner[ownerKey] = (overdueByOwner[ownerKey] ?? 0) + 1;
  }

  const latestImport = input.importBatches.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null;
  const refundImports = input.importBatches.filter((batch) => batch.acceptedRefunds > 0 || batch.duplicateRefunds > 0 || batch.issues.some((issue) => issue.entity === "refund"));
  const hasRefundSource = input.refunds.length > 0 || refundImports.length > 0;
  const refundDataStatus = hasRefundSource ? "records_only" as const : input.importHistoryVisible ? "not_imported" as const : "not_visible" as const;
  const latestRefundImport = refundImports.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null;
  const unassignedCohort = paidOrders.filter((order) => !effectiveOwner(order, input.ownerCorrections));
  const completedNetAmount = addCents(netAmount, 0);
  const scheduleRange = input.schedules.filter((schedule) => inRange(schedule.plannedStartAt, bounds.start, bounds.end));

  return {
    range: { from: bounds.from, to: bounds.to, timeZone: "Asia/Shanghai" },
    observedAt: now,
    creators: {
      total: input.creators.length,
      public: input.creators.filter((creator) => creator.ownerMemberId === null).length,
      assigned: input.creators.filter((creator) => creator.ownerMemberId !== null).length,
      byStage,
    },
    funnel: { basis: "first_contact", cohortSize: cohort.length, observedThrough: observedDate, byStage: funnel },
    sampleBacklog: {
      pendingApproval: input.samples.filter((sample) => sample.status === "pending_approval").length,
      pendingShipment: input.samples.filter((sample) => sample.status === "pending_shipment").length,
      shipped: input.samples.filter((sample) => sample.status === "shipped").length,
      pendingReceiptPackages: input.samplePackages.filter((pkg) => pkg.receivedAt === null).length,
    },
    cooperations: input.cooperations.reduce((counts, item) => { counts[item.status] += 1; return counts; }, makeCooperationCounts()),
    schedules: {
      planned: scheduleRange.filter((item) => item.status === "planned" || item.status === "rescheduled").length,
      upcoming: scheduleRange.filter((item) => (item.status === "planned" || item.status === "rescheduled") && Date.parse(item.plannedStartAt) >= nowMs).length,
      completed: scheduleRange.filter((item) => item.status === "completed").length,
      overdue: scheduleRange.filter((item) => (item.status === "planned" || item.status === "rescheduled") && Date.parse(item.plannedEndAt) < nowMs).length,
    },
    deliveryOnTime: { onTime: deliveredOnTime, due: deliveryDue.length, rate: deliveryDue.length === 0 ? null : deliveredOnTime / deliveryDue.length },
    paidOrders: { count: paidOrders.length, amount: { knownCents: paidAmount, unknownCount: paidUnknown, complete: paidUnknown === 0 }, unassignedCount: unassigned.length, unassignedKnownCents: unassignedKnown },
    refunds: { count: activityRefunds.length, amount: refundAmount, unknownCount: unknownRefundCount },
    netPaidCohort: { count: paidOrders.length, amount: { knownCents: completedNetAmount, unknownCount: netUnknownCount, complete: netUnknownCount === 0 && refundDataStatus === "records_only" } },
    overdueTasks: { count: overdue.length, byOwner: overdueByOwner, withoutDeadlineCount },
    dataCoverage: {
      sourceCoverage: "imported_records_only",
      importHistoryVisible: input.importHistoryVisible,
      refundDataStatus,
      importedBatches: input.importBatches.length,
      latestImportAt: latestImport?.createdAt ?? null,
      latestRefundImportAt: latestRefundImport?.createdAt ?? null,
      issues: input.importBatches.reduce((count, batch) => count + batch.issues.length, 0),
      unassignedOrderCount: unassignedCohort.length,
    },
  };
}
