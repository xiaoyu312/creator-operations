import type {
  Capability,
  CooperationStatus,
  CrmStage,
  DeliveryStatus,
  DeliveryType,
  OrderStatus,
  Platform,
  SampleStatus,
  ScheduleStatus,
  SalesReportAccountingStatus,
  ShanghaiDate,
} from "./types.ts";

export type BusinessProgressOwnerKey = string;

export type BusinessProgressActionCode =
  | "log_followup"
  | "review_paused_creator"
  | "submit_cooperation"
  | "review_cooperation"
  | "submit_sample_request"
  | "create_sample_request"
  | "approve_sample_request"
  | "ship_samples"
  | "confirm_sample_receipt"
  | "create_delivery"
  | "schedule_live"
  | "confirm_live_status"
  | "record_live_completion"
  | "submit_live_delivery"
  | "submit_short_video_delivery"
  | "review_delivery"
  | "reconcile_sales"
  | "inspect_record"
  | "none";

export type BusinessProgressActionState = "task" | "suggested" | "unregistered" | "none";

export interface BusinessProgressNextAction {
  state: BusinessProgressActionState;
  code: BusinessProgressActionCode;
  ownerKey: BusinessProgressOwnerKey | null;
  dueAt: string | null;
  taskKind: "followup" | "sample_approval" | "sample_shipment" | "sample_receipt" | "cooperation_approval" | "schedule" | "delivery_review" | "other" | null;
  requiredCapability: Capability | null;
}

export interface BusinessProgressWorkspace {
  observedAt: string;
  observedOn: ShanghaiDate;
  owners: BusinessProgressOwner[];
  ownerDirectory: BusinessProgressOwnerDirectoryEntry[];
  creatorRelations: BusinessProgressCreator[];
  unassignedCreatorKeys: string[];
  salesEntries: BusinessProgressSalesEntry[];
  unattributedSales: {
    paidOrderLineCount: number;
    knownGrossCents: number;
    unknownOrderAmountCount: number;
    unknownPaidAtOrderLineCount: number;
    unknownRefundDateCount: number;
    manualReportCount: number;
    countedManualGmvCents: number;
    duplicateConflictCount: number;
  };
}

export type BusinessProgressSalesEntryStatus =
  | OrderStatus
  | "succeeded"
  | "pending"
  | "reversed"
  | "unknown"
  | "pending_review"
  | "approved"
  | "returned";

export interface BusinessProgressSalesEntry {
  kind: "order" | "refund" | "manual";
  /** Internal domain record key only; never a platform order, refund, or video ID. */
  sourceKey: string;
  creatorKey: string | null;
  ownerKey: BusinessProgressOwnerKey | null;
  ownerBasis: "paid_at_snapshot" | "correction" | "report_owner" | "unassigned" | "unknown" | "not_applicable";
  platform: Platform;
  date: ShanghaiDate | null;
  occurredAt: string | null;
  amountCents: number | null;
  status: BusinessProgressSalesEntryStatus;
  accountingStatus: SalesReportAccountingStatus | null;
  refundDirection: "refund" | "reversal" | null;
}

export interface BusinessProgressOwner {
  /** Opaque internal member key; never a platform principal ID. */
  key: BusinessProgressOwnerKey;
  displayName: string;
  active: boolean;
  kind: "work_owner" | "sales_only" | "report_only";
  creatorLinks: BusinessProgressOwnerCreatorLink[];
}

/** Authorized, non-principal identities for resolving task owner keys in the UI. */
export interface BusinessProgressOwnerDirectoryEntry {
  key: BusinessProgressOwnerKey;
  displayName: string;
  active: boolean;
}

export interface BusinessProgressOwnerCreatorLink {
  creatorKey: string;
  relation: "current" | "cooperation";
  /** Present for cooperation links; sales always remain at creator/owner ledger grain. */
  workItemKeys: string[];
}

export interface BusinessProgressCreator {
  key: string;
  name: string;
  currentOwnerKey: BusinessProgressOwnerKey | null;
  platforms: Platform[];
  crmStage: CrmStage;
  crmStageAt: string | null;
  lastFollowupAt: string | null;
  nextAction: BusinessProgressNextAction;
  workItems: BusinessProgressCooperationWorkItem[];
  directSamples: BusinessProgressSampleRequest[];
  sales: BusinessProgressCreatorSales;
}

export interface BusinessProgressCooperationWorkItem {
  key: string;
  title: string;
  cooperationOwnerKey: BusinessProgressOwnerKey | null;
  platforms: Platform[];
  products: Array<{ key: string; name: string; platform: Platform | null }>;
  unresolvedProductLineCount: number;
  status: CooperationStatus;
  updatedAt: string;
  sampleProgress: BusinessProgressSampleProgress;
  scheduleProgress: BusinessProgressScheduleProgress;
  deliveryProgress: BusinessProgressDeliveryProgress;
  nextAction: BusinessProgressNextAction;
  /** Orders and reports have no cooperation key; never allocate their sales to this item. */
  salesAttribution: "creator_summary_only";
}

export type BusinessProgressSampleProgressState =
  | "not_required"
  | "waived"
  | "awaiting_request"
  | "incomplete_data"
  | "pending_approval"
  | "pending_shipment"
  | "partially_shipped"
  | "shipped"
  | "partially_received"
  | "received"
  | "rejected"
  | "closed";

export interface BusinessProgressSampleProgress {
  state: BusinessProgressSampleProgressState;
  requiredRequestCount: number;
  presentRequestCount: number;
  requiredQuantity: number | null;
  shippedQuantity: number | null;
  receivedQuantity: number | null;
  requests: BusinessProgressSampleRequest[];
}

export interface BusinessProgressSampleRequest {
  key: string;
  status: SampleStatus;
  platforms: Platform[];
  updatedAt: string;
  required: boolean;
  requiredQuantity: number | null;
  shippedQuantity: number | null;
  receivedQuantity: number | null;
  nextAction: BusinessProgressNextAction;
}

export type BusinessProgressScheduleTiming = "upcoming" | "in_window" | "overdue" | "unknown";

export interface BusinessProgressScheduleProgress {
  next: {
    key: string;
    status: Extract<ScheduleStatus, "planned" | "rescheduled">;
    plannedStartAt: string;
    plannedEndAt: string;
    timing: BusinessProgressScheduleTiming;
  } | null;
  overdueCount: number;
  cancelledCount: number;
  completionRecordedCount: number;
  completionMissingActualTimeCount: number;
  latestRecordedCompletion: {
    actualStartAt: string;
    actualEndAt: string;
  } | null;
}

export interface BusinessProgressDeliveryCount {
  deliveryType: DeliveryType;
  requiredCount: number;
  pendingSubmissionCount: number;
  pendingReviewCount: number;
  returnedCount: number;
  approvedCount: number;
  cancelledCount: number;
}

export interface BusinessProgressDeliveryProgress {
  byType: BusinessProgressDeliveryCount[];
  /** Approved here means internal delivery review passed, not platform verification. */
  hasApprovedLiveDelivery: boolean;
}

export interface BusinessProgressSalesByOwner {
  ownerKey: BusinessProgressOwnerKey | null;
  paidOrderLineCount: number;
  knownGrossCents: number;
  unknownOrderAmountCount: number;
  unknownPaidAtOrderLineCount: number;
  knownRefundCents: number;
  unknownRefundAmountCount: number;
  unknownRefundDateCount: number;
  knownNetCents: number;
  netComplete: boolean;
}

export interface BusinessProgressManualSalesByOwner {
  ownerKey: BusinessProgressOwnerKey | null;
  reportCount: number;
  countedCount: number;
  countedGmvCents: number;
  unreviewedCount: number;
  returnedCount: number;
  reconciliationRequiredCount: number;
  replacedByOrdersCount: number;
}

export interface BusinessProgressCreatorSales {
  paidOrderLineCount: number;
  knownGrossCents: number;
  unknownOrderAmountCount: number;
  unknownPaidAtOrderLineCount: number;
  succeededRefundCount: number;
  knownRefundCents: number;
  unknownRefundAmountCount: number;
  unknownRefundDateCount: number;
  knownNetCents: number;
  refundCoverage: "records_only" | "not_imported" | "unknown";
  netComplete: boolean;
  unassignedOrderLineCount: number;
  byOwner: BusinessProgressSalesByOwner[];
  manualReports: BusinessProgressManualSalesByOwner[];
  /** Count only; CreatorSessionRecord GMV is historical manual reference, never actual sales. */
  historicalManualSessionCount: number;
}

export type BusinessProgressReportAccountingStatus = SalesReportAccountingStatus;
export type BusinessProgressOrderStatus = OrderStatus;
export type BusinessProgressDeliveryStatus = DeliveryStatus;
