import { z } from "zod";
import {
  CAPABILITIES,
  CREATOR_COMMERCE_TYPES,
  CRM_STAGES,
  DELIVERY_TYPES,
  CONTENT_ASSET_TYPES,
  CONTENT_RIGHT_SCOPES,
  CONTENT_RIGHTS_STATUSES,
  COMMERCIAL_LEDGER_KINDS,
  PARTNER_RESOURCE_KINDS,
  TEAM_MONTHLY_TARGET_METRICS,
  FOLLOWUP_CHANNELS,
  FOLLOWUP_RESULTS,
  ORDER_STATUSES,
  PLATFORMS,
  ROLES,
  TASK_KINDS,
  type Capability,
  type CrmStage,
  type DeliveryType,
  type FollowupChannel,
  type FollowupResult,
  type ImportOrderRow,
  type ImportCreatorRow,
  type ImportRefundRow,
  type OrderStatus,
  type Platform,
  type Role,
  type TaskKind,
} from "./types.ts";

const id = z.string().trim().min(1).max(160);
const text = z.string().trim().min(1).max(4000);
const optionalText = z.string().trim().max(4000).nullable().optional();
const shortText = z.string().trim().min(1).max(300);
const optionalShortText = z.string().trim().max(300).nullable().optional();
const isoDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/, "必须包含明确时区的 ISO 时间").refine((value) => Number.isFinite(Date.parse(value)), "无效日期时间");
const shanghaiDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00+08:00`);
  return Number.isFinite(date.getTime()) && date.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }) === value;
}, "必须是有效的上海日期 YYYY-MM-DD");
const expectedVersion = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const money = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const nullableMoney = money.nullable();
const quantity = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const nullableQuantity = quantity.nullable();
const nullableMetricCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
const httpUrl = z.string().trim().url().max(2048).refine((value) => value.startsWith("https://") || value.startsWith("http://"), "只支持 http/https 链接").nullable();
const safeHttpUrl = httpUrl.refine((value) => {
  if (value === null) return true;
  const parsed = new URL(value);
  return parsed.username.length === 0 && parsed.password.length === 0;
}, "链接不能包含账号凭据");
const requiredSafeHttpUrl = z.string().trim().url().max(2048).refine((value) => {
  if (!value.startsWith("https://") && !value.startsWith("http://")) return false;
  const parsed = new URL(value);
  return parsed.username.length === 0 && parsed.password.length === 0;
}, "只支持不含账号凭据的 http/https 链接");
const platform = z.enum(PLATFORMS);
const commerceTypes = z.array(z.enum(CREATOR_COMMERCE_TYPES))
  .max(CREATOR_COMMERCE_TYPES.length)
  .refine((values) => new Set(values).size === values.length, "达人带货类型不能重复");
const role = z.enum(ROLES);
const capability = z.enum(CAPABILITIES);

const obj = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
type CommandSchema<N extends string, T extends z.ZodRawShape> = z.ZodObject<{ type: z.ZodLiteral<N> } & T>;
const command = <N extends string, T extends z.ZodRawShape>(type: N, shape: T): CommandSchema<N, T> =>
  z.object({ type: z.literal(type), ...shape }).strict() as unknown as CommandSchema<N, T>;
const sampleLine = obj({ productId: id, quantity });
const cooperationLine = obj({
  productId: id.nullable().optional(), productName: shortText, sku: optionalShortText,
  specification: optionalShortText, agreedPriceCents: nullableMoney.optional(),
  agreedQuantity: nullableQuantity.optional(), deliveryRequirement: text, note: optionalText,
  storeId: id.nullable().optional(), storeAssortmentId: id.nullable().optional(),
  assortmentVersion: z.number().int().positive().nullable().optional(), livePriceCents: nullableMoney.optional(),
  creatorCommissionBps: z.number().int().min(0).max(10000).nullable().optional(),
  sellingPointsSnapshot: z.array(shortText).max(20).optional(), sellingPointEvidenceUrl: safeHttpUrl.optional(),
  salesCardUrl: safeHttpUrl.optional(), productGroupsSnapshot: z.array(shortText).max(30).optional(),
});
const recipient = obj({ recipientName: shortText, phone: z.string().trim().max(80).nullable(), address: text });
const contact = obj({ contactName: z.string().trim().max(200).nullable(), phone: z.string().trim().max(80).nullable(), email: z.string().trim().max(300).nullable(), handle: z.string().trim().max(300).nullable() });
const shipmentLine = obj({ sampleLineId: id, productId: id, quantity });
const nextAction = obj({ title: shortText, dueAt: isoDateTime, priority: z.enum(["low", "normal", "high"]).default("normal") });

const importOrder = obj({
  rowNumber: z.number().int().positive(), platform: platform.default("douyin"), shopId: z.string().trim().max(200).nullable(),
  externalOrderId: z.string().trim().max(200), externalLineId: z.string().trim().max(200),
  productId: id.nullable(), sku: z.string().trim().max(200).nullable(),
  creatorAccountId: z.string().trim().max(300).nullable(), paidAt: isoDateTime.nullable(),
  sourceStatus: z.string().trim().max(200), status: z.enum(ORDER_STATUSES),
  paidAmountCents: nullableMoney, rawAmount: z.string().max(200).nullable(),
});
const importCreator = obj({
  rowNumber: z.number().int().positive(), platform: platform.default("douyin"), externalAccountId: z.string().trim().min(1).max(300),
  name: shortText, displayName: shortText, profileUrl: httpUrl, category: z.string().trim().max(300).nullable(),
  tags: z.array(shortText).max(50), source: shortText,
  contact: contact.nullable(),
});
const importRefund = obj({
  rowNumber: z.number().int().positive(), platform: platform.default("douyin"), shopId: z.string().trim().max(200).nullable(),
  externalRefundId: z.string().trim().max(200), externalOrderId: z.string().trim().max(200),
  externalLineId: z.string().trim().max(200), refundedAt: isoDateTime.nullable(),
  sourceStatus: z.string().trim().max(200), status: z.enum(["succeeded", "pending", "reversed", "unknown"]),
  amountCents: nullableMoney, direction: z.enum(["refund", "reversal"]), rawAmount: z.string().max(200).nullable(),
});

const salesReportFields = {
  creatorId: id, creatorAccountId: id, storeId: id,
  commerceType: z.enum(CREATOR_COMMERCE_TYPES), title: shortText,
  contentId: optionalShortText, contentUrl: safeHttpUrl.optional(),
  productIds: z.array(id).min(1).max(30), periodStartAt: isoDateTime, periodEndAt: isoDateTime,
  gmvCents: money, orderCount: nullableMetricCount.optional(),
  evidenceUrl: safeHttpUrl.optional(), evidenceNote: optionalText,
};

const schemas = [
  command("salesReport.create", salesReportFields),
  command("salesReport.update", { ...salesReportFields, reportId: id, expectedVersion }),
  command("salesReport.review", { reportId: id, expectedVersion, decision: z.enum(["approved", "returned"]), reason: optionalText }),
  command("salesReport.reconcile", { reportId: id, expectedVersion, reason: text }),
  command("creator.create", {
    name: shortText, platform: platform.optional(), externalAccountId: z.string().trim().min(1).max(300), displayName: shortText,
    profileUrl: httpUrl.optional(), commerceTypes: commerceTypes.optional(), category: optionalShortText, tags: z.array(shortText).max(50).default([]),
    source: shortText.default("manual"), contact: contact.partial().optional(), internalNote: optionalText,
    makePublic: z.boolean().default(false),
  }),
  command("creator.update", {
    creatorId: id, expectedVersion, name: shortText.optional(), category: optionalShortText,
    expectedProfileVersion: expectedVersion.optional(),
    expectedContactVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    tags: z.array(shortText).max(50).optional(), contact: contact.partial().nullable().optional(), internalNote: optionalText,
  }),
  command("creator.addAccount", { creatorId: id, expectedVersion, expectedProfileVersion: expectedVersion.optional(), platform: platform.optional(), externalAccountId: z.string().trim().min(1).max(300), displayName: shortText, profileUrl: httpUrl.optional(), commerceTypes: commerceTypes.optional() }),
  command("creator.updateAccount", {
    creatorId: id, accountId: id, expectedVersion, expectedProfileVersion: expectedVersion,
    expectedAccountVersion: expectedVersion, displayName: shortText.optional(), profileUrl: httpUrl.optional(),
    active: z.boolean().optional(), commerceTypes: commerceTypes.optional(),
  }),
  command("creator.claim", { creatorId: id, expectedVersion }),
  command("creator.transfer", { creatorId: id, targetMemberId: id, expectedVersion, effectiveAt: isoDateTime, reason: text }),
  command("creator.setStage", {
    creatorId: id, expectedVersion, stage: z.enum(CRM_STAGES), occurredAt: isoDateTime,
    reason: optionalText, reviewAt: isoDateTime.nullable().optional(),
  }),
  command("creator.merge", { sourceCreatorId: id, targetCreatorId: id, expectedSourceVersion: expectedVersion, expectedTargetVersion: expectedVersion, reason: text }),
  command("followup.add", {
    creatorId: id, expectedCreatorVersion: expectedVersion, occurredAt: isoDateTime,
    channel: z.enum(FOLLOWUP_CHANNELS), result: z.enum(FOLLOWUP_RESULTS), summary: text,
    accountId: z.string().trim().max(300).nullable().optional(), evidenceUrl: httpUrl.optional(), nextAction: nextAction.nullable().optional(),
  }),
  command("creator.session.create", {
    creatorId: id, creatorAccountId: id, commerceType: z.enum(CREATOR_COMMERCE_TYPES), occurredOn: shanghaiDate,
    title: shortText, productIds: z.array(id).max(30).optional(), gmvCents: nullableMoney.optional(),
    orderCount: nullableMetricCount.optional(), contentUrl: safeHttpUrl.optional(), note: optionalText,
  }),
  command("creator.session.update", {
    sessionId: id, expectedVersion,
    creatorAccountId: id.optional(), commerceType: z.enum(CREATOR_COMMERCE_TYPES).optional(),
    occurredOn: shanghaiDate.optional(), title: shortText.optional(), productIds: z.array(id).max(30).optional(),
    gmvCents: nullableMoney.optional(), orderCount: nullableMetricCount.optional(), contentUrl: safeHttpUrl.optional(),
    note: optionalText,
  }),
  command("task.complete", { taskId: id, expectedVersion, completedAt: isoDateTime, note: optionalText }),
  command("task.create", {
    creatorId: id.nullable().optional(), kind: z.enum(TASK_KINDS), title: shortText, ownerMemberId: id,
    dueAt: isoDateTime.nullable(), relatedType: z.enum(["creator", "sample", "cooperation", "schedule", "delivery"]).nullable().optional(),
    relatedId: id.nullable().optional(), priority: z.enum(["low", "normal", "high"]).default("normal"),
  }),
  command("product.create", {
    brand: shortText, name: shortText, sku: optionalShortText, specification: optionalShortText,
    sampleCostCents: nullableMoney.optional(), note: optionalText,
  }),
  command("product.update", {
    productId: id, expectedVersion, brand: shortText.optional(), name: shortText.optional(),
    sku: optionalShortText, specification: optionalShortText, sampleCostCents: nullableMoney.optional(),
    active: z.boolean().optional(), note: optionalText,
  }),
  command("catalog.saveProduct", {
    storeId: id.optional(),
    newStore: obj({ platform, externalShopId: z.string().trim().min(1).max(300), name: shortText, note: optionalText }).optional(),
    productId: id.optional(),
    newProduct: obj({ brand: shortText, name: shortText, sku: optionalShortText, specification: optionalShortText, sampleCostCents: nullableMoney.optional(), note: optionalText }).optional(),
    priceCents: nullableMoney.optional(), livePriceCents: nullableMoney.optional(),
    creatorCommissionBps: z.number().int().min(0).max(10000).nullable().optional(), salesCardUrl: safeHttpUrl.optional(),
  }),
  command("store.create", {
    teamId: id.optional(), platform, externalShopId: z.string().trim().min(1).max(300), name: shortText, note: optionalText,
  }),
  command("store.update", {
    storeId: id, expectedVersion, name: shortText.optional(), note: optionalText, active: z.boolean().optional(),
  }),
  command("assortment.create", {
    storeId: id, productId: id, priceCents: nullableMoney.optional(), livePriceCents: nullableMoney.optional(),
    creatorCommissionBps: z.number().int().min(0).max(10000).nullable().optional(),
    mainSellingPoints: z.array(shortText).max(20).default([]), sellingPointEvidenceUrl: safeHttpUrl.optional(),
    salesCardUrl: safeHttpUrl.optional(), productGroups: z.array(shortText).max(30).default([]),
    validFrom: isoDateTime.nullable().optional(), validUntil: isoDateTime.nullable().optional(),
  }),
  command("assortment.update", {
    assortmentId: id, expectedVersion, priceCents: nullableMoney.optional(), livePriceCents: nullableMoney.optional(),
    creatorCommissionBps: z.number().int().min(0).max(10000).nullable().optional(),
    mainSellingPoints: z.array(shortText).max(20).optional(), sellingPointEvidenceUrl: safeHttpUrl.optional(),
    salesCardUrl: safeHttpUrl.optional(), productGroups: z.array(shortText).max(30).optional(),
    validFrom: isoDateTime.nullable().optional(), validUntil: isoDateTime.nullable().optional(), active: z.boolean().optional(),
  }),
  command("proposal.create", {
    creatorId: id, title: shortText, deliveryRequirement: text, sampleRequirement: z.enum(["required", "none"]),
    assortmentIds: z.array(id).min(1).max(20),
  }),
  command("proposal.updateDraft", {
    proposalId: id, expectedVersion, title: shortText.optional(), deliveryRequirement: text.optional(),
    sampleRequirement: z.enum(["required", "none"]).optional(), assortmentIds: z.array(id).min(1).max(20).optional(),
  }),
  command("proposal.submit", { proposalId: id, expectedVersion }),
  command("proposal.recordOutcome", {
    proposalId: id, expectedVersion, outcome: z.enum(["accepted", "rejected"]), note: optionalText,
  }),
  command("proposal.cancel", { proposalId: id, expectedVersion, reason: text }),
  command("proposal.convert", { proposalId: id, expectedVersion }),
  command("partnerResource.create", {
    teamId: id.optional(), kind: z.enum(PARTNER_RESOURCE_KINDS), name: shortText, summary: text,
    tags: z.array(shortText).max(50).default([]), contactName: z.string().trim().max(200).nullable().optional(),
    contactPhone: z.string().trim().max(80).nullable().optional(), contactHandle: z.string().trim().max(300).nullable().optional(),
    privateNote: optionalText,
  }),
  command("partnerResource.update", {
    resourceId: id, expectedVersion, name: shortText.optional(), summary: text.optional(), tags: z.array(shortText).max(50).optional(),
    contactName: z.string().trim().max(200).nullable().optional(), contactPhone: z.string().trim().max(80).nullable().optional(),
    contactHandle: z.string().trim().max(300).nullable().optional(), privateNote: optionalText, active: z.boolean().optional(),
  }),
  command("cooperationPartnerLink.create", {
    cooperationId: id, partnerResourceId: id, role: z.enum(["lead_source", "service_provider", "other"]), note: optionalText,
  }),
  command("cooperationPartnerLink.update", {
    linkId: id, expectedVersion, role: z.enum(["lead_source", "service_provider", "other"]).optional(), note: optionalText, active: z.boolean().optional(),
  }),
  command("contentAsset.create", {
    creatorId: id, sourceUrl: requiredSafeHttpUrl, assetType: z.enum(CONTENT_ASSET_TYPES), title: shortText,
    tags: z.array(shortText).max(50).default([]), productIds: z.array(id).max(30).default([]),
  }),
  command("contentAsset.registerFromDelivery", {
    deliveryId: id, expectedDeliveryVersion: expectedVersion, sourceUrl: requiredSafeHttpUrl,
    assetType: z.enum(CONTENT_ASSET_TYPES), title: shortText, tags: z.array(shortText).max(50).default([]), productIds: z.array(id).max(30).default([]),
  }),
  command("contentAsset.update", {
    assetId: id, expectedVersion, assetType: z.enum(CONTENT_ASSET_TYPES).optional(),
    title: shortText.optional(), tags: z.array(shortText).max(50).optional(), productIds: z.array(id).max(30).optional(),
  }),
  command("contentAsset.updateRights", {
    assetId: id, expectedVersion, rightsStatus: z.enum(CONTENT_RIGHTS_STATUSES),
    rightsScope: z.array(z.enum(CONTENT_RIGHT_SCOPES)).max(CONTENT_RIGHT_SCOPES.length).default([]),
    rightsValidFrom: isoDateTime.nullable(), rightsValidUntil: isoDateTime.nullable(),
    rightsEvidenceUrl: safeHttpUrl, reason: optionalText,
  }),
  command("contentObservation.append", {
    assetId: id, expectedAssetVersion: expectedVersion, source: shortText, observedAt: isoDateTime,
    views: nullableMetricCount.optional(), likes: nullableMetricCount.optional(), comments: nullableMetricCount.optional(), shares: nullableMetricCount.optional(),
    orders: nullableMetricCount.optional(), observedPaidCents: nullableMoney.optional(), note: optionalText,
  }),
  command("ledgerEntry.create", {
    teamId: id, title: shortText, kind: z.enum(COMMERCIAL_LEDGER_KINDS), amountCents: money.refine((value) => value > 0, "登记费用必须大于 0"),
    occurredAt: isoDateTime, source: shortText, evidenceUrl: safeHttpUrl.optional(),
    cooperationId: id.nullable().optional(), contentAssetId: id.nullable().optional(),
  }),
  command("ledgerEntry.void", { entryId: id, expectedVersion, voidReason: text }),
  command("teamTarget.upsert", {
    teamId: id, month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), metric: z.enum(TEAM_MONTHLY_TARGET_METRICS),
    targetValue: money, expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }),
  command("sample.create", {
    creatorId: id, expectedCreatorVersion: expectedVersion, cooperationId: id.nullable().optional(),
    lines: z.array(sampleLine).min(1).max(100), recipient: recipient.nullable().optional(), reason: text,
    originalRequestId: id.nullable().optional(),
  }),
  command("sample.request", {
    creatorId: id, creatorAccountId: id, expectedCreatorVersion: expectedVersion, cooperationId: id.nullable().optional(),
    lines: z.array(sampleLine).min(1).max(100), recipient: recipient.nullable().optional(), reason: text,
    originalRequestId: id.nullable().optional(),
  }),
  command("sample.updateDraft", {
    sampleId: id, expectedVersion, lines: z.array(sampleLine).min(1).max(100).optional(),
    recipient: recipient.nullable().optional(), reason: text.optional(),
  }),
  command("sample.submit", { sampleId: id, expectedVersion, submittedAt: isoDateTime }),
  command("sample.decide", { sampleId: id, expectedVersion, decision: z.enum(["approved", "rejected"]), decidedAt: isoDateTime, reason: text.nullable().optional() }),
  command("sample.addPackage", {
    sampleId: id, expectedVersion, carrier: shortText, trackingNumber: shortText,
    lines: z.array(shipmentLine).min(1).max(100), shippedAt: isoDateTime,
  }),
  command("sample.confirmReceipt", {
    sampleId: id, expectedSampleVersion: expectedVersion, packageId: id, expectedPackageVersion: expectedVersion,
    receivedAt: isoDateTime, evidenceUrl: httpUrl.optional(),
  }),
  command("sample.close", { sampleId: id, expectedVersion, closedAt: isoDateTime, reason: text }),
  command("cooperation.create", {
    creatorId: id, expectedCreatorVersion: expectedVersion, title: shortText,
    lines: z.array(cooperationLine).min(1).max(100), sampleRequirement: z.enum(["required", "none"]),
    deliveryRequirement: text, startAt: isoDateTime.nullable().optional(), endAt: isoDateTime.nullable().optional(), note: optionalText,
  }),
  command("cooperation.updateDraft", {
    cooperationId: id, expectedVersion, title: shortText.optional(), lines: z.array(cooperationLine).min(1).max(100).optional(),
    sampleRequirement: z.enum(["required", "none"]).optional(), deliveryRequirement: text.optional(),
    startAt: isoDateTime.nullable().optional(), endAt: isoDateTime.nullable().optional(), note: optionalText,
  }),
  command("cooperation.submit", { cooperationId: id, expectedVersion, submittedAt: isoDateTime }),
  command("cooperation.decide", { cooperationId: id, expectedVersion, decision: z.enum(["approved", "rejected"]), decidedAt: isoDateTime, reason: text.nullable().optional() }),
  command("cooperation.waiveSamples", { cooperationId: id, expectedVersion, waivedAt: isoDateTime, reason: text }),
  command("cooperation.cancel", { cooperationId: id, expectedVersion, cancelledAt: isoDateTime, reason: text }),
  command("schedule.create", {
    cooperationId: id, expectedCooperationVersion: expectedVersion, cooperationLineId: id.nullable().optional(),
    title: shortText, platform: z.enum(PLATFORMS), roomId: z.string().trim().max(300).nullable().optional(),
    plannedStartAt: isoDateTime, plannedEndAt: isoDateTime,
  }),
  command("schedule.reschedule", {
    scheduleId: id, expectedVersion, plannedStartAt: isoDateTime, plannedEndAt: isoDateTime, changedAt: isoDateTime, reason: text,
  }),
  command("schedule.complete", { scheduleId: id, expectedVersion, actualStartAt: isoDateTime.nullable().optional(), actualEndAt: isoDateTime, reviewUrl: httpUrl.optional() }),
  command("schedule.cancel", { scheduleId: id, expectedVersion, cancelledAt: isoDateTime, reason: text }),
  command("delivery.create", {
    cooperationId: id, expectedCooperationVersion: expectedVersion, cooperationLineId: id.nullable().optional(),
    scheduleId: id.nullable().optional(), deliveryType: z.enum(DELIVERY_TYPES), title: shortText, dueAt: isoDateTime,
    required: z.boolean().default(true),
  }),
  command("delivery.submit", {
    deliveryId: id, expectedVersion, submittedAt: isoDateTime, contentUrl: httpUrl.optional(),
    platformContentId: z.string().trim().max(300).nullable().optional(), evidenceUrl: httpUrl.optional(), note: optionalText,
  }),
  command("delivery.review", { deliveryId: id, expectedVersion, decision: z.enum(["approved", "returned"]), reviewedAt: isoDateTime, reason: text.nullable().optional() }),
  command("delivery.cancel", { deliveryId: id, expectedVersion, cancelledAt: isoDateTime, reason: text }),
  command("import.preview", {
    batchId: id, sourceName: shortText, creators: z.array(importCreator).max(50000).default([]),
    orders: z.array(importOrder).max(50000).default([]), refunds: z.array(importRefund).max(50000).default([]),
  }),
  command("import.commit", {
    batchId: id, sourceName: shortText, creators: z.array(importCreator).max(50000).default([]),
    orders: z.array(importOrder).max(50000).default([]), refunds: z.array(importRefund).max(50000).default([]),
  }),
  command("order.reconcileSource", {
    orderLineId: id, expectedVersion, resolution: z.enum(["paid", "closed"]), sourceStatus: shortText,
    paidAt: isoDateTime.nullable().optional(), paidAmountCents: nullableMoney.optional(), rawAmount: z.string().max(200).nullable().optional(),
    creatorAccountId: z.string().trim().max(300).nullable().optional(), sourceEvidenceUrl: httpUrl.optional(), reason: text,
  }),
  command("refund.reconcileSource", {
    refundId: id, expectedVersion, resolution: z.enum(["succeeded", "reversed"]), sourceStatus: shortText,
    refundedAt: isoDateTime, amountCents: nullableMoney, rawAmount: z.string().max(200).nullable(),
    sourceEvidenceUrl: httpUrl.optional(), reason: text,
  }),
  command("order.correctOwner", { orderLineId: id, expectedVersion, correctedMemberId: id.nullable(), correctedAt: isoDateTime, reason: text }),
  command("member.create", {
    principalId: z.string().trim().min(1).max(300), displayName: shortText, teamId: id,
    role: role.optional(), capabilities: z.array(capability).max(CAPABILITIES.length).optional(),
  }),
  command("member.update", {
    memberId: id, expectedVersion, displayName: shortText.optional(), teamId: id.optional(), role: role.optional(),
    capabilities: z.array(capability).max(CAPABILITIES.length).optional(), active: z.boolean().optional(),
  }),
  command("member.handoff", { sourceMemberId: id, targetMemberId: id, effectiveAt: isoDateTime, reason: text, deactivateSource: z.boolean().default(false) }),
  command("export.record", { dataset: z.enum(["creators", "creatorSessions", "samples", "cooperations", "schedules", "deliveries", "orders", "refunds", "tasks"]), filters: obj({ dateFrom: shanghaiDate.optional(), dateTo: shanghaiDate.optional(), teamId: id.optional(), ownerMemberId: id.optional(), platform: z.enum([...PLATFORMS, "all"]).optional(), creatorId: id.optional(), search: z.string().trim().max(300).optional() }).optional() }),
] as const;

const commandSchema = z.discriminatedUnion("type", schemas);
export type DomainCommand = z.infer<typeof commandSchema>;
export type CreatorCreateCommand = Extract<DomainCommand, { type: "creator.create" }>;
export type ImportPreviewCommand = Extract<DomainCommand, { type: "import.preview" }>;
export type ImportCommitCommand = Extract<DomainCommand, { type: "import.commit" }>;

export function parseCommand(input: unknown): DomainCommand {
  return commandSchema.parse(input);
}

export function commandImportRows(command: ImportPreviewCommand | ImportCommitCommand): { creators: ImportCreatorRow[]; orders: ImportOrderRow[]; refunds: ImportRefundRow[] } {
  return { creators: command.creators, orders: command.orders, refunds: command.refunds };
}

export function assertKnownRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}
export function assertKnownCapability(value: unknown): value is Capability {
  return typeof value === "string" && (CAPABILITIES as readonly string[]).includes(value);
}
export function assertKnownCrmStage(value: unknown): value is CrmStage {
  return typeof value === "string" && (CRM_STAGES as readonly string[]).includes(value);
}
export function assertKnownFollowup(value: unknown): value is FollowupChannel | FollowupResult {
  return typeof value === "string" && ([...FOLLOWUP_CHANNELS, ...FOLLOWUP_RESULTS] as readonly string[]).includes(value);
}
export function assertKnownPlatform(value: unknown): value is Platform {
  return typeof value === "string" && (PLATFORMS as readonly string[]).includes(value);
}
export function assertKnownTaskKind(value: unknown): value is TaskKind {
  return typeof value === "string" && (TASK_KINDS as readonly string[]).includes(value);
}
export function assertKnownDeliveryType(value: unknown): value is DeliveryType {
  return typeof value === "string" && (DELIVERY_TYPES as readonly string[]).includes(value);
}
