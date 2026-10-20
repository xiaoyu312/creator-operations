/** Pure domain contracts shared by the API and the web client. */

export type Id = string;
export type IsoDateTime = string;
export type ShanghaiDate = string; // YYYY-MM-DD, interpreted at Asia/Shanghai boundaries.
export type MoneyCents = number;
/** Local workbook data are real source records, separate from synthetic demo and platform production. */
export type DataMode = "demo" | "production" | "local";

import type { BusinessProgressWorkspace } from "./business-progress.ts";

export const ROLES = ["admin", "manager", "bd", "ops"] as const;
export type Role = (typeof ROLES)[number];

export const CAPABILITIES = [
  "sample.approve",
  "sample.fulfill",
  "cooperation.approve",
  "import.manage",
  "audit.read",
  "export.run",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface Actor {
  /** Trusted platform principal resolved by the server, never copied from request body. */
  principalId: string;
  /** Production authorization is supplied by verified host roles, never by Member.role. */
  platformAccess?: {
    role: Role | null;
    capabilities: Capability[];
    sourceRoleState: "present" | "missing";
  };
}

export interface Versioned {
  version: number;
  createdAt: IsoDateTime;
  createdBy: Id;
  updatedAt: IsoDateTime;
  updatedBy: Id;
}

export interface Scoped {
  orgId: Id;
  teamId: Id;
}

export interface Member extends Versioned, Scoped {
  id: Id;
  principalId: string;
  displayName: string;
  /** Demo compatibility only; production persistence must store null and never authorize from these. */
  role: Role | null;
  /** Demo compatibility only; production persistence must store null and never authorize from these. */
  capabilities: Capability[] | null;
  active: boolean;
}

export interface Team {
  id: Id;
  orgId: Id;
  name: string;
  active: boolean;
  version: number;
}

export const PLATFORMS = ["douyin", "channels", "xiaohongshu", "kuaishou"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const CREATOR_COMMERCE_TYPES = ["short_video", "live"] as const;
export type CreatorCommerceType = (typeof CREATOR_COMMERCE_TYPES)[number];

export interface CreatorAccount {
  id: Id;
  platform: Platform;
  externalAccountId: string;
  displayName: string;
  profileUrl: string | null;
  active: boolean;
  /** [] means the account's commerce types are unknown. */
  commerceTypes?: CreatorCommerceType[];
  /** Shared directory CAS version; absent in older local snapshots. */
  accountVersion?: number;
  firstSeenAt: IsoDateTime;
  lastVerifiedAt: IsoDateTime | null;
}

export const CRM_STAGES = [
  "uncontacted",
  "contacted",
  "responded",
  "negotiating",
  "cooperating",
  "paused",
  "declined",
] as const;
export type CrmStage = (typeof CRM_STAGES)[number];

export interface Creator extends Versioned, Scoped {
  id: Id;
  /** Shared identity; id remains the brand relationship key for workflow records. */
  profileId?: Id;
  /** Independent shared-profile CAS, present in brand-persistent workspaces. */
  profileVersion?: number;
  /** Brand-private contact CAS; zero means no contact record has been created. */
  contactVersion?: number;
  name: string;
  category: string | null;
  tags: string[];
  source: string;
  accounts: CreatorAccount[];
  ownerMemberId: Id | null;
  crmStage: CrmStage;
  pausedFromStage: CrmStage | null;
  pauseReason: string | null;
  reviewAt: IsoDateTime | null;
  declineReason: string | null;
  contact: CreatorContact | null;
  internalNote: string | null;
  archived: boolean;
  mergedIntoCreatorId: Id | null;
}

export interface CreatorContact {
  contactName: string | null;
  phone: string | null;
  email: string | null;
  handle: string | null;
}

export interface OwnerAssignment extends Scoped {
  id: Id;
  creatorId: Id;
  memberId: Id | null;
  validFrom: IsoDateTime;
  validTo: IsoDateTime | null;
  changedBy: Id;
  reason: string;
}

export interface CreatorStageEvent extends Scoped {
  id: Id;
  creatorId: Id;
  stage: CrmStage;
  occurredAt: IsoDateTime;
  recordedAt: IsoDateTime;
  actorId: Id;
  reason: string | null;
}

export const FOLLOWUP_CHANNELS = ["phone", "wechat", "platform_dm", "email", "meeting", "other"] as const;
export type FollowupChannel = (typeof FOLLOWUP_CHANNELS)[number];
export const FOLLOWUP_RESULTS = ["no_answer", "contacted", "responded", "negotiating", "not_interested", "other"] as const;
export type FollowupResult = (typeof FOLLOWUP_RESULTS)[number];

export interface Followup extends Versioned, Scoped {
  id: Id;
  creatorId: Id;
  occurredAt: IsoDateTime;
  channel: FollowupChannel;
  result: FollowupResult;
  summary: string;
  accountId: string | null;
  evidenceUrl: string | null;
}

/** Brand-local manual performance history, independent from order records. */
export interface CreatorSessionRecord extends Versioned, Scoped {
  id: Id;
  creatorId: Id;
  creatorAccountId: Id;
  platform: Platform;
  commerceType: CreatorCommerceType;
  occurredOn: ShanghaiDate;
  title: string;
  productIds: Id[];
  gmvCents: MoneyCents | null;
  orderCount: number | null;
  contentUrl: string | null;
  note: string | null;
  source: "manual";
}

/** Current-period business sales reports; distinct from CRM historical reference data. */
export interface SalesPerformanceReport extends Versioned, Scoped {
  id: Id;
  creatorId: Id;
  creatorAccountId: Id;
  platform: Platform;
  externalAccountId: string;
  storeId: Id;
  shopId: string;
  commerceType: CreatorCommerceType;
  title: string;
  /** A stable platform video ID is required for short-video reports. */
  contentId: string | null;
  contentUrl: string | null;
  productIds: Id[];
  /** Shanghai-period bounds, start inclusive and end exclusive. */
  periodStartAt: IsoDateTime;
  periodEndAt: IsoDateTime;
  /** Live start date or short-video period end date; never a proportional allocation. */
  creditedOn: ShanghaiDate;
  gmvCents: MoneyCents;
  orderCount: number | null;
  ownerMemberId: Id;
  evidenceUrl: string | null;
  evidenceNote: string | null;
  status: "pending_review" | "approved" | "returned";
  submittedAt: IsoDateTime;
  reviewedBy: Id | null;
  reviewedAt: IsoDateTime | null;
  reviewNote: string | null;
  reconciledBy: Id | null;
  reconciledAt: IsoDateTime | null;
  reconciliationNote: string | null;
}

export type SalesReportAccountingStatus = "unreviewed" | "returned" | "counted" | "reconciliation_required" | "replaced_by_orders";
export interface SalesPerformanceWorkspaceItem extends SalesPerformanceReport {
  /** Computed from all brand orders before applying user/query visibility filters. */
  accountingStatus: SalesReportAccountingStatus;
  /** Null when the exact count is outside this actor's order visibility. */
  overlappingOrderCount: number | null;
}

export const TASK_KINDS = ["followup", "sample_approval", "sample_shipment", "sample_receipt", "cooperation_approval", "schedule", "delivery_review", "other"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const TASK_STATUSES = ["open", "completed", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface WorkTask extends Versioned, Scoped {
  id: Id;
  creatorId: Id | null;
  kind: TaskKind;
  title: string;
  ownerMemberId: Id | null;
  requiredCapability: Capability | null;
  dueAt: IsoDateTime | null;
  status: TaskStatus;
  relatedType: "creator" | "sample" | "cooperation" | "schedule" | "delivery" | null;
  relatedId: Id | null;
  completedAt: IsoDateTime | null;
  completionNote: string | null;
  priority: "low" | "normal" | "high";
}

export interface Product extends Versioned, Scoped {
  id: Id;
  brand: string;
  name: string;
  sku: string | null;
  specification: string | null;
  sampleCostCents: MoneyCents | null;
  active: boolean;
  note: string | null;
}

export const SAMPLE_STATUSES = ["draft", "pending_approval", "pending_shipment", "shipped", "received", "rejected", "closed"] as const;
export type SampleStatus = (typeof SAMPLE_STATUSES)[number];

export interface SampleLine {
  id: Id;
  productId: Id;
  quantity: number;
}

export interface RecipientInfo {
  recipientName: string;
  phone: string | null;
  address: string;
}

export interface SampleRequest extends Versioned, Scoped {
  id: Id;
  creatorId: Id;
  /** Missing on historical rows means the destination account is unknown. */
  creatorAccountId?: Id;
  /** Derived on direct requests; missing historical values remain unknown. */
  platform?: Platform;
  cooperationId: Id | null;
  applicantId: Id;
  lines: SampleLine[];
  recipient: RecipientInfo | null;
  shippingBlocked: boolean;
  reason: string;
  status: SampleStatus;
  decidedBy: Id | null;
  decidedAt: IsoDateTime | null;
  decisionReason: string | null;
  closeReason: string | null;
  originalRequestId: Id | null;
}

export interface SampleShipmentLine {
  sampleLineId: Id;
  productId: Id;
  quantity: number;
}

export interface SamplePackage extends Versioned, Scoped {
  id: Id;
  sampleId: Id;
  carrier: string;
  trackingNumber: string;
  lines: SampleShipmentLine[];
  shippedAt: IsoDateTime;
  shippedBy: Id;
  receivedAt: IsoDateTime | null;
  receivedBy: Id | null;
  receiptEvidenceUrl: string | null;
}

export const COOPERATION_STATUSES = ["draft", "pending_approval", "rejected", "pending_samples_shipment", "pending_samples_receipt", "pending_delivery", "delivered", "cancelled"] as const;
export type CooperationStatus = (typeof COOPERATION_STATUSES)[number];

export interface CooperationLine {
  id: Id;
  productId: Id | null;
  productName: string;
  sku: string | null;
  specification: string | null;
  agreedPriceCents: MoneyCents | null;
  agreedQuantity: number | null;
  deliveryRequirement: string;
  note: string | null;
  /** Optional frozen store-offer terms; legacy hand-entered cooperation lines omit these. */
  storeId?: Id | null;
  storeAssortmentId?: Id | null;
  assortmentVersion?: number | null;
  livePriceCents?: MoneyCents | null;
  creatorCommissionBps?: number | null;
  sellingPointsSnapshot?: string[];
  sellingPointEvidenceUrl?: string | null;
  salesCardUrl?: string | null;
  productGroupsSnapshot?: string[];
}

export const STORE_CONNECTION_MODES = ["manual"] as const;
export const STORE_CONNECTION_STATUSES = ["not_connected"] as const;
export interface ManualStore extends Versioned, Scoped {
  id: Id;
  platform: Platform;
  externalShopId: string;
  name: string;
  note: string | null;
  active: boolean;
  connectionMode: (typeof STORE_CONNECTION_MODES)[number];
  connectionStatus: (typeof STORE_CONNECTION_STATUSES)[number];
}

export interface StoreAssortment extends Versioned, Scoped {
  id: Id;
  storeId: Id;
  productId: Id;
  priceCents: MoneyCents | null;
  livePriceCents: MoneyCents | null;
  /** Creator promotion commission rate, expressed as basis points; this is not BD commission. */
  creatorCommissionBps: number | null;
  mainSellingPoints: string[];
  sellingPointEvidenceUrl: string | null;
  salesCardUrl: string | null;
  productGroups: string[];
  validFrom: IsoDateTime | null;
  validUntil: IsoDateTime | null;
  active: boolean;
}

export interface CreatorProductProposalItem {
  storeAssortmentId: Id;
  assortmentVersion: number;
  storeId: Id;
  productId: Id;
  productVersion: number;
  productName: string;
  sku: string | null;
  specification: string | null;
  priceCents: MoneyCents | null;
  livePriceCents: MoneyCents | null;
  creatorCommissionBps: number | null;
  mainSellingPoints: string[];
  sellingPointEvidenceUrl: string | null;
  salesCardUrl: string | null;
  productGroups: string[];
}

export const CREATOR_PRODUCT_PROPOSAL_STATUSES = ["draft", "proposed", "accepted", "rejected", "converted", "cancelled"] as const;
export type CreatorProductProposalStatus = (typeof CREATOR_PRODUCT_PROPOSAL_STATUSES)[number];
export interface CreatorProductProposal extends Versioned, Scoped {
  id: Id;
  creatorId: Id;
  title: string;
  deliveryRequirement: string;
  sampleRequirement: "required" | "none";
  items: CreatorProductProposalItem[];
  status: CreatorProductProposalStatus;
  proposedAt: IsoDateTime | null;
  outcomeAt: IsoDateTime | null;
  outcomeNote: string | null;
  convertedCooperationId: Id | null;
}

export const PARTNER_RESOURCE_KINDS = ["leader", "agency"] as const;
export type PartnerResourceKind = (typeof PARTNER_RESOURCE_KINDS)[number];
export interface PartnerResource extends Versioned, Scoped {
  id: Id;
  kind: PartnerResourceKind;
  name: string;
  summary: string;
  tags: string[];
  contactName: string | null;
  contactPhone: string | null;
  contactHandle: string | null;
  privateNote: string | null;
  active: boolean;
}

export const COOPERATION_PARTNER_ROLES = ["lead_source", "service_provider", "other"] as const;
export interface CooperationPartnerLink extends Versioned, Scoped {
  id: Id;
  cooperationId: Id;
  partnerResourceId: Id;
  role: (typeof COOPERATION_PARTNER_ROLES)[number];
  note: string | null;
  active: boolean;
}

export const CONTENT_ASSET_TYPES = ["short_video", "live", "live_replay", "image", "script", "other"] as const;
export type ContentAssetType = (typeof CONTENT_ASSET_TYPES)[number];
export const CONTENT_RIGHTS_STATUSES = ["unknown", "pending", "authorized", "revoked"] as const;
export type ContentRightsStatus = (typeof CONTENT_RIGHTS_STATUSES)[number];
export const CONTENT_RIGHT_SCOPES = ["publish", "edit", "paid_media"] as const;
export type ContentRightScope = (typeof CONTENT_RIGHT_SCOPES)[number];
export interface ContentAsset extends Versioned, Scoped {
  id: Id;
  creatorId: Id;
  deliveryId: Id | null;
  sourceUrl: string;
  type: ContentAssetType;
  title: string;
  tags: string[];
  productIds: Id[];
  rightsStatus: ContentRightsStatus;
  rightsScope: ContentRightScope[];
  rightsValidFrom: IsoDateTime | null;
  rightsValidUntil: IsoDateTime | null;
  rightsEvidenceUrl: string | null;
}

export interface ContentAssetWorkspaceItem extends ContentAsset {
  authorizationEffectiveNow: boolean;
  effectiveRightsScope: ContentRightScope[];
}

/** Append-only manual observations; observedAt is source event time, recordedAt is system entry time. */
export interface ContentObservation extends Scoped {
  id: Id;
  contentAssetId: Id;
  source: string;
  observedAt: IsoDateTime;
  recordedAt: IsoDateTime;
  recordedBy: Id;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  orders: number | null;
  observedPaidCents: MoneyCents | null;
  note: string | null;
}

export const COMMERCIAL_LEDGER_KINDS = ["cooperation_fee", "sample_logistics", "ad_spend", "other"] as const;
export type CommercialLedgerKind = (typeof COMMERCIAL_LEDGER_KINDS)[number];
export const COMMERCIAL_LEDGER_STATUSES = ["recorded", "voided"] as const;
export type CommercialLedgerStatus = (typeof COMMERCIAL_LEDGER_STATUSES)[number];
export interface CommercialLedgerEntry extends Versioned, Scoped {
  id: Id;
  title: string;
  kind: CommercialLedgerKind;
  amountCents: MoneyCents;
  occurredAt: IsoDateTime;
  source: string;
  evidenceUrl: string | null;
  cooperationId: Id | null;
  contentAssetId: Id | null;
  status: CommercialLedgerStatus;
  voidReason: string | null;
}

export const TEAM_MONTHLY_TARGET_METRICS = ["paid_gmv", "approved_deliveries", "new_contacts"] as const;
export type TeamMonthlyTargetMetric = (typeof TEAM_MONTHLY_TARGET_METRICS)[number];
export interface TeamMonthlyTarget extends Versioned, Scoped {
  id: Id;
  month: string;
  metric: TeamMonthlyTargetMetric;
  targetValue: number;
}

/** Workspace-only derived actual; never persisted as a target. */
export interface TeamMonthlyTargetWorkspaceItem extends TeamMonthlyTarget {
  actualValue: number;
  actualUnknownCount: number;
  actualComplete: boolean;
  actualSource: "visible_domain_records_only";
}

export interface BusinessRuleNote {
  id: "paid_at_owner" | "workflow_sla";
  title: string;
  body: string;
}
export const WORKSPACE_BUSINESS_RULE_NOTES: readonly BusinessRuleNote[] = Object.freeze([
  { id: "paid_at_owner", title: "订单归属", body: "订单按支付时点的达人负责人快照归属；负责人转交不改写历史订单。人工更正须保留原因和审计。" },
  { id: "workflow_sla", title: "流程时限", body: "审核与交付验收 24 小时、获批样品待发货 48 小时、样品待签收 7 天；无截止时间的任务单独标示。" },
]);

export interface Cooperation extends Versioned, Scoped {
  id: Id;
  creatorId: Id;
  ownerMemberId: Id;
  title: string;
  lines: CooperationLine[];
  sampleRequirement: "required" | "none";
  requiredSampleIds: Id[];
  deliveryRequirement: string;
  status: CooperationStatus;
  applicantId: Id;
  decidedBy: Id | null;
  decidedAt: IsoDateTime | null;
  decisionReason: string | null;
  rejectionReason: string | null;
  cancellationReason: string | null;
  waivedSamplesReason: string | null;
  startAt: IsoDateTime | null;
  endAt: IsoDateTime | null;
  note: string | null;
}

export const SCHEDULE_STATUSES = ["planned", "rescheduled", "completed", "cancelled"] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];
export interface ScheduleVersion {
  plannedStartAt: IsoDateTime;
  plannedEndAt: IsoDateTime;
  changedAt: IsoDateTime;
  changedBy: Id;
  reason: string;
}

export interface LiveSchedule extends Versioned, Scoped {
  id: Id;
  creatorId: Id;
  cooperationId: Id;
  cooperationLineId: Id | null;
  ownerMemberId: Id;
  platform: Platform;
  roomId: string | null;
  title: string;
  plannedStartAt: IsoDateTime;
  plannedEndAt: IsoDateTime;
  history: ScheduleVersion[];
  status: ScheduleStatus;
  changeReason: string | null;
  actualStartAt: IsoDateTime | null;
  actualEndAt: IsoDateTime | null;
  reviewUrl: string | null;
}

export const DELIVERY_TYPES = ["short_video", "live", "other"] as const;
export type DeliveryType = (typeof DELIVERY_TYPES)[number];
export const DELIVERY_STATUSES = ["pending_submission", "pending_review", "returned", "approved", "cancelled"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export interface DeliverySubmission {
  submittedAt: IsoDateTime;
  submittedBy: Id;
  contentUrl: string | null;
  platformContentId: string | null;
  evidenceUrl: string | null;
  note: string | null;
}
export interface DeliveryReview {
  decision: "approved" | "returned";
  reviewedAt: IsoDateTime;
  reviewedBy: Id;
  reason: string | null;
  submissionIndex: number;
}

export interface Delivery extends Versioned, Scoped {
  id: Id;
  creatorId: Id;
  cooperationId: Id;
  cooperationLineId: Id | null;
  scheduleId: Id | null;
  ownerMemberId: Id;
  type: DeliveryType;
  title: string;
  dueAt: IsoDateTime;
  required: boolean;
  status: DeliveryStatus;
  submissions: DeliverySubmission[];
  reviews: DeliveryReview[];
  cancellationReason: string | null;
}

export const ORDER_STATUSES = ["paid", "pending", "cancelled", "closed", "unknown"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export interface OwnerSnapshot {
  memberId: Id | null;
  assignedAt: IsoDateTime | null;
  ruleVersion: "paid_at_owner_v1";
  reason: "matched" | "creator_unmatched" | "no_owner_at_paid_at" | "ambiguous_owner" | "payment_not_finalized";
}

export interface OrderLine extends Scoped {
  id: Id;
  platform: Platform;
  shopId: string | null;
  externalOrderId: string;
  externalLineId: string;
  productId: Id | null;
  sku: string | null;
  creatorAccountId: string | null;
  creatorId: Id | null;
  paidAt: IsoDateTime | null;
  sourceStatus: string;
  status: OrderStatus;
  paidAmountCents: MoneyCents | null;
  rawAmount: string | null;
  ownerSnapshot: OwnerSnapshot;
  sourceEvidenceUrl: string | null;
  importBatchId: Id;
  sourceRowNumber: number;
  contentFingerprint: string;
  createdAt: IsoDateTime;
  createdBy: Id;
  updatedAt: IsoDateTime;
  updatedBy: Id;
  version: number;
}

export interface RefundEvent extends Scoped {
  id: Id;
  platform: Platform;
  shopId: string | null;
  externalRefundId: string;
  orderLineId: Id;
  refundedAt: IsoDateTime | null;
  sourceStatus: string;
  status: "succeeded" | "pending" | "reversed" | "unknown";
  amountCents: MoneyCents | null;
  direction: "refund" | "reversal";
  rawAmount: string | null;
  sourceEvidenceUrl: string | null;
  importBatchId: Id;
  sourceRowNumber: number;
  contentFingerprint: string;
  createdAt: IsoDateTime;
  createdBy: Id;
  version: number;
}

export interface ImportIssue {
  rowNumber: number;
  entity: "creator" | "order" | "refund";
  key: string | null;
  code: "invalid_row" | "missing_identity" | "missing_date" | "conflicting_replay" | "order_not_found" | "refund_exceeds_payment" | "refund_reversal_exceeds_refund" | "duplicate_in_batch" | "creator_identity_conflict";
  message: string;
  existingId: Id | null;
}
export interface ImportBatch extends Scoped {
  id: Id;
  kind: "creators" | "orders_and_refunds" | "mixed";
  sourceName: string;
  payloadFingerprint: string;
  status: "committed" | "committed_with_issues";
  createdAt: IsoDateTime;
  createdBy: Id;
  acceptedCreators: number;
  duplicateCreators: number;
  acceptedOrders: number;
  duplicateOrders: number;
  acceptedRefunds: number;
  duplicateRefunds: number;
  issues: ImportIssue[];
}

export type AuditEntityType = "member" | "creator" | "creator_session" | "sales_report" | "followup" | "task" | "product" | "sample" | "sample_package" | "cooperation" | "schedule" | "delivery" | "order" | "refund" | "import" | "export" | "manual_store" | "store_assortment" | "creator_product_proposal" | "partner_resource" | "cooperation_partner_link" | "content_asset" | "content_observation" | "commercial_ledger_entry" | "team_monthly_target";
export interface AuditEvent extends Scoped {
  id: Id;
  actorId: Id;
  entityType: AuditEntityType;
  entityId: Id;
  action: string;
  occurredAt: IsoDateTime;
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface DomainState {
  schemaVersion: 1;
  dataMode: DataMode;
  orgId: Id;
  teams: Team[];
  members: Member[];
  creators: Creator[];
  ownerAssignments: OwnerAssignment[];
  creatorStageEvents: CreatorStageEvent[];
  followups: Followup[];
  creatorSessions: CreatorSessionRecord[];
  salesReports: SalesPerformanceReport[];
  tasks: WorkTask[];
  products: Product[];
  manualStores: ManualStore[];
  storeAssortments: StoreAssortment[];
  creatorProductProposals: CreatorProductProposal[];
  partnerResources: PartnerResource[];
  cooperationPartnerLinks: CooperationPartnerLink[];
  contentAssets: ContentAsset[];
  contentObservations: ContentObservation[];
  commercialLedgerEntries: CommercialLedgerEntry[];
  teamMonthlyTargets: TeamMonthlyTarget[];
  samples: SampleRequest[];
  samplePackages: SamplePackage[];
  cooperations: Cooperation[];
  schedules: LiveSchedule[];
  deliveries: Delivery[];
  orders: OrderLine[];
  refunds: RefundEvent[];
  ownerCorrections: OwnerCorrection[];
  importBatches: ImportBatch[];
  auditEvents: AuditEvent[];
}

export interface WorkspaceFilters {
  dateFrom?: ShanghaiDate;
  dateTo?: ShanghaiDate;
  teamId?: Id;
  ownerMemberId?: Id;
  search?: string;
  /** Export-only selector; normal workspace reads continue to use server-defined scope. */
  platform?: Platform | "all";
  /** Export-only selector for records attributed to one visible creator. */
  creatorId?: Id;
  includeClosed?: boolean;
}

export interface MetricAmount {
  knownCents: MoneyCents;
  unknownCount: number;
  complete: boolean;
}
export interface WorkspaceMetrics {
  range: { from: ShanghaiDate | null; to: ShanghaiDate | null; timeZone: "Asia/Shanghai" };
  observedAt: IsoDateTime;
  creators: { total: number; public: number; assigned: number; byStage: Record<CrmStage, number> };
  funnel: { basis: "first_contact"; cohortSize: number; observedThrough: ShanghaiDate; byStage: Record<CrmStage, number> };
  sampleBacklog: { pendingApproval: number; pendingShipment: number; shipped: number; pendingReceiptPackages: number };
  cooperations: Record<CooperationStatus, number>;
  schedules: { planned: number; upcoming: number; completed: number; overdue: number };
  deliveryOnTime: { onTime: number; due: number; rate: number | null };
  paidOrders: { count: number; amount: MetricAmount; unassignedCount: number; unassignedKnownCents: MoneyCents };
  refunds: { count: number; amount: MoneyCents; unknownCount: number };
  netPaidCohort: { count: number; amount: MetricAmount };
  overdueTasks: { count: number; byOwner: Record<Id, number>; withoutDeadlineCount: number };
  dataCoverage: {
    sourceCoverage: "imported_records_only";
    importHistoryVisible: boolean;
    refundDataStatus: "not_imported" | "records_only" | "not_visible";
    importedBatches: number;
    latestImportAt: IsoDateTime | null;
    latestRefundImportAt: IsoDateTime | null;
    issues: number;
    unassignedOrderCount: number;
  };
}

/** Read-only provenance for an isolated scenario workspace; never an access grant. */
export interface WorkspaceScenarioInfo {
  kind: "source_scenario";
  classification: "real_or_mixed";
  sourceBrandId: Id;
  sourceFileName: string;
  sourceSha256: string;
  sourceReadAt: IsoDateTime;
  sourceRowCount: number;
  referenceDate: ShanghaiDate;
  sourceCreatorCount: number;
  sourceAccountCount: number;
  simulatedAccountCount: number;
  sourceProductCount: number;
  simulatedFields: string[];
}

export interface WorkspaceSnapshot {
  dataMode: DataMode;
  scenarioInfo?: WorkspaceScenarioInfo;
  /** Read-only management projection; absent for business and operations roles. */
  businessProgress?: BusinessProgressWorkspace;
  actor: { memberId: Id; displayName: string; role: Role; capabilities: Capability[]; teamId: Id };
  scope: { teamIds: Id[]; canSeeTeamMetrics: boolean; canManageMembers: boolean };
  metrics: WorkspaceMetrics;
  businessRuleNotes: BusinessRuleNote[];
  members: Array<Pick<Member, "id" | "displayName" | "role" | "teamId" | "active" | "version">>;
  teams: Team[];
  creators: Creator[];
  ownerAssignments: OwnerAssignment[];
  followups: Followup[];
  creatorSessions: CreatorSessionRecord[];
  salesReports: SalesPerformanceWorkspaceItem[];
  tasks: WorkTask[];
  products: Product[];
  manualStores: ManualStore[];
  storeAssortments: StoreAssortment[];
  creatorProductProposals: CreatorProductProposal[];
  partnerResources: PartnerResource[];
  cooperationPartnerLinks: CooperationPartnerLink[];
  contentAssets: ContentAssetWorkspaceItem[];
  contentObservations: ContentObservation[];
  commercialLedgerEntries: CommercialLedgerEntry[];
  teamMonthlyTargets: TeamMonthlyTargetWorkspaceItem[];
  samples: SampleRequest[];
  samplePackages: SamplePackage[];
  cooperations: Cooperation[];
  schedules: LiveSchedule[];
  deliveries: Delivery[];
  orders: OrderLine[];
  refunds: RefundEvent[];
  ownerCorrections: OwnerCorrection[];
  importBatches: ImportBatch[];
  auditEvents: AuditEvent[];
}

export interface DemoProfile {
  principalId: string;
  memberId: Id;
  displayName: string;
  role: Role;
  teamId: Id;
}

export interface SessionSnapshot {
  dataMode: DataMode;
  actor: { memberId: Id; principalId: string; displayName: string; role: Role; capabilities: Capability[]; teamId: Id };
  allowedDemoProfiles: DemoProfile[];
}

export type DomainErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "VERSION_CONFLICT"
  | "INVALID_TRANSITION"
  | "IDENTITY_CONFLICT"
  | "IMPORT_CONFLICT"
  | "DUPLICATE"
  | "BUSINESS_RULE_VIOLATION";

export interface DomainCommandResult<T = unknown> {
  command: string;
  result: T;
  notices: string[];
}

export interface ImportOrderRow {
  rowNumber: number;
  /** Omitted legacy requests are interpreted as Douyin at the command boundary. */
  platform?: Platform;
  shopId: string | null;
  externalOrderId: string;
  externalLineId: string;
  productId: Id | null;
  sku: string | null;
  creatorAccountId: string | null;
  paidAt: IsoDateTime | null;
  sourceStatus: string;
  status: OrderStatus;
  paidAmountCents: MoneyCents | null;
  rawAmount: string | null;
}

export interface ImportCreatorRow {
  rowNumber: number;
  platform: Platform;
  externalAccountId: string;
  name: string;
  displayName: string;
  profileUrl: string | null;
  category: string | null;
  tags: string[];
  source: string;
  contact: CreatorContact | null;
}
export interface ImportRefundRow {
  rowNumber: number;
  /** Omitted legacy requests are interpreted as Douyin at the command boundary. */
  platform?: Platform;
  shopId: string | null;
  externalRefundId: string;
  externalOrderId: string;
  externalLineId: string;
  refundedAt: IsoDateTime | null;
  sourceStatus: string;
  status: "succeeded" | "pending" | "reversed" | "unknown";
  amountCents: MoneyCents | null;
  direction: "refund" | "reversal";
  rawAmount: string | null;
}

export interface ImportPreviewResult {
  batchId: Id;
  kind: ImportBatch["kind"];
  payloadFingerprint: string;
  totals: {
    creators: number;
    orders: number;
    refunds: number;
  };
  creates: { creators: number; orders: number; refunds: number };
  duplicates: { creators: number; orders: number; refunds: number };
  conflicts: number;
  errors: number;
  issues: ImportIssue[];
}

export interface OwnerCorrection extends Scoped {
  id: Id;
  orderLineId: Id;
  previousMemberId: Id | null;
  correctedMemberId: Id | null;
  correctedAt: IsoDateTime;
  recordedAt: IsoDateTime;
  correctedBy: Id;
  reason: string;
}
