import type {
  CooperationStatus,
  Creator,
  CreatorAccount,
  CreatorSessionRecord,
  CreatorStageEvent,
  Delivery,
  DomainState,
  Followup,
  Id,
  LiveSchedule,
  Member,
  OrderLine,
  OwnerCorrection,
  OwnerSnapshot,
  Platform,
  Product,
  RefundEvent,
  SamplePackage,
  SampleRequest,
  SalesPerformanceReport,
  TaskKind,
  TaskStatus,
  WorkTask,
} from "../../shared/types.ts";

type ScopedKey = Pick<Member, "orgId" | "teamId">;
type CreatorAccountIdentity = Pick<CreatorAccount, "id" | "platform" | "externalAccountId">;

export interface BusinessProgressMemberSource extends ScopedKey {
  id: Id;
  displayName: string;
  active: boolean;
}

export interface BusinessProgressCreatorSource extends ScopedKey {
  id: Id;
  name: string;
  ownerMemberId: Id | null;
  crmStage: Creator["crmStage"];
  reviewAt: string | null;
  archived: boolean;
  mergedIntoCreatorId: Id | null;
  accounts: CreatorAccountIdentity[];
}

export interface BusinessProgressStageEventSource extends ScopedKey {
  creatorId: Id;
  stage: CreatorStageEvent["stage"];
  occurredAt: string;
}

export interface BusinessProgressFollowupSource extends ScopedKey {
  creatorId: Id;
  occurredAt: string;
}

export interface BusinessProgressTaskSource extends ScopedKey {
  id: Id;
  creatorId: Id | null;
  ownerMemberId: Id | null;
  requiredCapability: WorkTask["requiredCapability"];
  kind: TaskKind;
  dueAt: string | null;
  status: TaskStatus;
  relatedType: WorkTask["relatedType"];
  relatedId: Id | null;
  priority: WorkTask["priority"];
}

export interface BusinessProgressCooperationSource extends ScopedKey {
  id: Id;
  creatorId: Id;
  ownerMemberId: Id;
  title: string;
  updatedAt: string;
  status: CooperationStatus;
  sampleRequirement: "required" | "none";
  requiredSampleIds: Id[];
  samplesWaived: boolean;
  lines: Array<{ productId: Id | null; platform: Platform | null }>;
}

export interface BusinessProgressProductSource extends ScopedKey {
  id: Id;
  name: string;
}

export interface BusinessProgressSampleSource extends ScopedKey {
  id: Id;
  creatorId: Id;
  cooperationId: Id | null;
  status: SampleRequest["status"];
  platform: Platform | null;
  shippingBlocked: boolean;
  updatedAt: string;
  lines: Array<Pick<SampleRequest["lines"][number], "id" | "quantity">>;
}

export interface BusinessProgressSamplePackageSource extends ScopedKey {
  id: Id;
  sampleId: Id;
  shippedAt: string;
  receivedAt: string | null;
  lines: Array<Pick<SamplePackage["lines"][number], "sampleLineId" | "quantity">>;
}

export interface BusinessProgressScheduleSource extends ScopedKey {
  id: Id;
  creatorId: Id;
  cooperationId: Id;
  ownerMemberId: Id;
  platform: LiveSchedule["platform"];
  status: LiveSchedule["status"];
  updatedAt: string;
  plannedStartAt: string;
  plannedEndAt: string;
  actualStartAt: string | null;
  actualEndAt: string | null;
}

export interface BusinessProgressDeliverySource extends ScopedKey {
  id: Id;
  creatorId: Id;
  cooperationId: Id;
  scheduleId: Id | null;
  type: Delivery["type"];
  required: boolean;
  status: Delivery["status"];
  dueAt: string;
}

/** External creator account IDs are server-only correlation keys and must never be returned to clients. */
export interface BusinessProgressOrderSource extends ScopedKey {
  id: Id;
  platform: OrderLine["platform"];
  shopId: string | null;
  externalOrderId: string;
  externalLineId: string;
  creatorAccountId: string | null;
  creatorId: Id | null;
  productId: Id | null;
  paidAt: string | null;
  status: OrderLine["status"];
  paidAmountCents: number | null;
  ownerSnapshot: OwnerSnapshot;
}

/** All-team, server-only matching keys within the already fixed-brand DomainState; never output or used for totals. */
export interface BusinessProgressOverlapOrderSource {
  orgId: Id;
  platform: OrderLine["platform"];
  shopId: string | null;
  creatorAccountId: string | null;
  creatorId: Id | null;
  productId: Id | null;
  paidAt: string | null;
  status: OrderLine["status"];
}

export interface BusinessProgressRefundSource extends ScopedKey {
  id: Id;
  externalRefundId: string;
  platform: RefundEvent["platform"];
  shopId: string | null;
  orderLineId: Id;
  refundedAt: string | null;
  status: RefundEvent["status"];
  amountCents: number | null;
  direction: RefundEvent["direction"];
}

export interface BusinessProgressOwnerCorrectionSource extends ScopedKey {
  id: Id;
  orderLineId: Id;
  recordedAt: string;
  correctedMemberId: Id | null;
}

export interface BusinessProgressSalesReportSource extends ScopedKey {
  id: Id;
  creatorId: Id;
  creatorAccountId: Id;
  platform: SalesPerformanceReport["platform"];
  externalAccountId: string;
  storeId: Id;
  shopId: string;
  productIds: Id[];
  periodStartAt: string;
  periodEndAt: string;
  creditedOn: string;
  gmvCents: number;
  ownerMemberId: Id;
  status: SalesPerformanceReport["status"];
  reconciledBy: Id | null;
  reconciledAt: string | null;
}

export interface BusinessProgressSessionSource extends ScopedKey {
  creatorId: Id;
  occurredOn: string;
}

/**
 * Narrow server-only input for the progress projection. It intentionally omits contact data,
 * evidence URLs, free-form reasons/notes, task titles, and manual-session GMV.
 */
export interface BusinessProgressSource {
  orgId: Id;
  teamIds: Id[];
  refundCoverage: "records_only" | "not_imported" | "unknown";
  members: BusinessProgressMemberSource[];
  creators: BusinessProgressCreatorSource[];
  stageEvents: BusinessProgressStageEventSource[];
  followups: BusinessProgressFollowupSource[];
  tasks: BusinessProgressTaskSource[];
  cooperations: BusinessProgressCooperationSource[];
  products: BusinessProgressProductSource[];
  samples: BusinessProgressSampleSource[];
  samplePackages: BusinessProgressSamplePackageSource[];
  schedules: BusinessProgressScheduleSource[];
  deliveries: BusinessProgressDeliverySource[];
  orders: BusinessProgressOrderSource[];
  overlapOrders: BusinessProgressOverlapOrderSource[];
  refunds: BusinessProgressRefundSource[];
  ownerCorrections: BusinessProgressOwnerCorrectionSource[];
  salesReports: BusinessProgressSalesReportSource[];
  creatorSessions: BusinessProgressSessionSource[];
}

function inScope(item: ScopedKey, orgId: Id, teamIds: ReadonlySet<Id>): boolean {
  return item.orgId === orgId && teamIds.has(item.teamId);
}

function refundSourcePresent(refunds: DomainState["refunds"], importBatches: DomainState["importBatches"]): boolean {
  return refunds.length > 0 || importBatches.some((batch) =>
    batch.acceptedRefunds > 0 || batch.duplicateRefunds > 0 || batch.issues.some((issue) => issue.entity === "refund"),
  );
}

/** Project a brand-bounded DomainState into the minimum safe source contract and scope progress to manager-authorized teams. */
export function businessProgressSourceFromDomainState(
  state: DomainState,
  authorizedTeamIds: readonly Id[],
): BusinessProgressSource {
  const teamIds = [...new Set(authorizedTeamIds)];
  const teamSet = new Set(teamIds);
  const scoped = <T extends ScopedKey>(items: readonly T[]): T[] => items.filter((item) => inScope(item, state.orgId, teamSet));
  const scopedStores = scoped(state.manualStores);
  const scopedAssortments = scoped(state.storeAssortments);
  const scopedRefunds = scoped(state.refunds);
  const scopedImportBatches = scoped(state.importBatches);
  const storeById = new Map(scopedStores.map((store) => [store.id, store]));
  const assortmentById = new Map(scopedAssortments.map((assortment) => [assortment.id, assortment]));
  const productPlatform = (line: DomainState["cooperations"][number]["lines"][number]): Platform | null => {
    const storeId = line.storeId ?? (line.storeAssortmentId ? assortmentById.get(line.storeAssortmentId)?.storeId : null);
    return storeId ? storeById.get(storeId)?.platform ?? null : null;
  };

  return {
    orgId: state.orgId,
    teamIds,
    refundCoverage: refundSourcePresent(scopedRefunds, scopedImportBatches) ? "records_only" : scopedImportBatches.length > 0 ? "not_imported" : "unknown",
    members: scoped(state.members).map(({ id, displayName, active, orgId, teamId }) => ({ id, displayName, active, orgId, teamId })),
    creators: scoped(state.creators).map(({ id, name, ownerMemberId, crmStage, reviewAt, archived, mergedIntoCreatorId, accounts, orgId, teamId }) => ({
      id, name, ownerMemberId, crmStage, reviewAt, archived, mergedIntoCreatorId,
      accounts: accounts.map(({ id: accountId, platform, externalAccountId }) => ({ id: accountId, platform, externalAccountId })),
      orgId, teamId,
    })),
    stageEvents: scoped(state.creatorStageEvents).map(({ creatorId, stage, occurredAt, orgId, teamId }) => ({ creatorId, stage, occurredAt, orgId, teamId })),
    followups: scoped(state.followups).map(({ creatorId, occurredAt, orgId, teamId }) => ({ creatorId, occurredAt, orgId, teamId })),
    tasks: scoped(state.tasks).map(({ id, creatorId, ownerMemberId, requiredCapability, kind, dueAt, status, relatedType, relatedId, priority, orgId, teamId }) => ({
      id, creatorId, ownerMemberId, requiredCapability, kind, dueAt, status, relatedType, relatedId, priority, orgId, teamId,
    })),
    cooperations: scoped(state.cooperations).map(({ id, creatorId, ownerMemberId, title, updatedAt, status, sampleRequirement, requiredSampleIds, waivedSamplesReason, lines, orgId, teamId }) => ({
      id, creatorId, ownerMemberId, title, updatedAt, status, sampleRequirement, requiredSampleIds: [...requiredSampleIds], samplesWaived: Boolean(waivedSamplesReason?.trim()),
      lines: lines.map((line) => ({ productId: line.productId, platform: productPlatform(line) })),
      orgId, teamId,
    })),
    products: scoped(state.products).map(({ id, name, orgId, teamId }: Product) => ({ id, name, orgId, teamId })),
    samples: scoped(state.samples).map(({ id, creatorId, cooperationId, platform, status, shippingBlocked, updatedAt, lines, orgId, teamId }) => ({
      id, creatorId, cooperationId, platform: platform ?? null, status, shippingBlocked, updatedAt,
      lines: lines.map(({ id: lineId, quantity }) => ({ id: lineId, quantity })), orgId, teamId,
    })),
    samplePackages: scoped(state.samplePackages).map(({ id, sampleId, shippedAt, receivedAt, lines, orgId, teamId }) => ({
      id, sampleId, shippedAt, receivedAt,
      lines: lines.map(({ sampleLineId, quantity }) => ({ sampleLineId, quantity })), orgId, teamId,
    })),
    schedules: scoped(state.schedules).map(({ id, creatorId, cooperationId, ownerMemberId, platform, status, updatedAt, plannedStartAt, plannedEndAt, actualStartAt, actualEndAt, orgId, teamId }) => ({
      id, creatorId, cooperationId, ownerMemberId, platform, status, updatedAt, plannedStartAt, plannedEndAt, actualStartAt, actualEndAt, orgId, teamId,
    })),
    deliveries: scoped(state.deliveries).map(({ id, creatorId, cooperationId, scheduleId, type, required, status, dueAt, orgId, teamId }) => ({
      id, creatorId, cooperationId, scheduleId, type, required, status, dueAt, orgId, teamId,
    })),
    orders: scoped(state.orders).map(({ id, platform, shopId, externalOrderId, externalLineId, creatorAccountId, creatorId, productId, paidAt, status, paidAmountCents, ownerSnapshot, orgId, teamId }) => ({
      id, platform, shopId, externalOrderId, externalLineId, creatorAccountId, creatorId, productId, paidAt, status, paidAmountCents,
      ownerSnapshot: { ...ownerSnapshot }, orgId, teamId,
    })),
    // DomainState is already isolated to one fixed brand. Include all teams in that state only for overlap checks.
    overlapOrders: state.orders.filter((order) => order.orgId === state.orgId).map(({ platform, shopId, creatorAccountId, creatorId, productId, paidAt, status, orgId }) => ({
      platform, shopId, creatorAccountId, creatorId, productId, paidAt, status, orgId,
    })),
    refunds: scoped(state.refunds).map(({ id, externalRefundId, platform, shopId, orderLineId, refundedAt, status, amountCents, direction, orgId, teamId }) => ({
      id, externalRefundId, platform, shopId, orderLineId, refundedAt, status, amountCents, direction, orgId, teamId,
    })),
    ownerCorrections: scoped(state.ownerCorrections).map(({ id, orderLineId, recordedAt, correctedMemberId, orgId, teamId }) => ({
      id, orderLineId, recordedAt, correctedMemberId, orgId, teamId,
    })),
    salesReports: scoped(state.salesReports).map(({ id, creatorId, creatorAccountId, platform, externalAccountId, storeId, shopId, productIds, periodStartAt, periodEndAt, creditedOn, gmvCents, ownerMemberId, status, reconciledBy, reconciledAt, orgId, teamId }) => ({
      id, creatorId, creatorAccountId, platform, externalAccountId, storeId, shopId, productIds: [...productIds], periodStartAt,
      periodEndAt, creditedOn, gmvCents, ownerMemberId, status, reconciledBy, reconciledAt, orgId, teamId,
    })),
    creatorSessions: scoped(state.creatorSessions).map(({ creatorId, occurredOn, orgId, teamId }: CreatorSessionRecord) => ({ creatorId, occurredOn, orgId, teamId })),
  };
}
