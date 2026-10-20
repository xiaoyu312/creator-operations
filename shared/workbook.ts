/** Read-only source workbook contract plus separately versioned local collaboration updates. */

export type WorkbookCell = string | number | null;
export type WorkbookSheetKind = "samples" | "broadcast" | "reference";
export type WorkbookExcelColumn = string;
export type WorkbookRecordOrigin = "source" | "local_entry";
export const WORKBOOK_PLATFORMS = ["douyin", "channels", "xiaohongshu", "kuaishou", "unknown"] as const;
export type WorkbookPlatform = (typeof WORKBOOK_PLATFORMS)[number];
export type WorkbookFieldState = "tracking_missing" | "tracking_recorded" | "link_missing" | "link_recorded";
export const WORKBOOK_PLATFORM_SOURCE_VALUES = Object.freeze({
  douyin: "抖音",
  channels: "视频号",
  xiaohongshu: "小红书",
  kuaishou: "快手",
} as const);

export const WORKBOOK_COORDINATION_STATUSES = ["unreviewed", "in_progress", "waiting", "resolved", "on_hold"] as const;
export type WorkbookCoordinationStatus = (typeof WORKBOOK_COORDINATION_STATUSES)[number];

/** UI hint only. The local service enforces a separate server-side label allowlist. */
export const WORKBOOK_EDITABLE_COLUMN_LABELS: Readonly<Record<WorkbookSheetKind, readonly string[]>> = Object.freeze({
  samples: ["备注", "是否可寄", "快递单号"],
  broadcast: ["设置状态", "其他要求", "链接/口令", "链接"],
  reference: [],
});

/** Server-side sensitivity aliases applied even if the parser omitted `sensitive: true`; role ACL may grant explicit field access. */
export const WORKBOOK_SENSITIVE_COLUMN_LABELS: Readonly<Record<WorkbookSheetKind, readonly string[]>> = Object.freeze({
  samples: ["收件人姓名", "收货人电话", "收货人详细地址"],
  broadcast: ["链接/口令", "链接"],
  reference: [],
});
export const WORKBOOK_MANUAL_CREATE_COLUMN_LABELS: Readonly<Record<Exclude<WorkbookSheetKind, "reference">, readonly string[]>> = Object.freeze({
  samples: ["填表日期", "平台", "寄样类型", "寄样商务", "达人名称", "合作模式", "产品名称", "正装数量", "空盒数量", "收件人姓名", "收货人电话", "收货人详细地址", "备注"],
  broadcast: ["填表日期", "对接商务", "平台", "达人名称", "小红书/抖音UID", "合作模式", "直播产品", "直播机制", "线上佣金", "线下佣金", "总佣金", "主图", "其他要求"],
});
export const WORKBOOK_BLANK_SOURCE_STATUS = "__blank__" as const;

export interface WorkbookSourceColumn {
  key: WorkbookExcelColumn;
  label: string;
  sensitive: boolean;
  editable?: boolean;
}

export interface WorkbookSourceRow {
  sourceRow: number;
  cells: Record<string, WorkbookCell>;
  issues: string[];
}

export interface WorkbookSheetManifest {
  sheetName: string;
  kind: WorkbookSheetKind;
  year: number | null;
  hidden: boolean;
  columns: WorkbookSourceColumn[];
  rows: WorkbookSourceRow[];
  issues?: string[];
  stats?: Record<string, number>;
}

/** Parsed workbook content is immutable after it is accepted by the local service. */
export interface WorkbookSourceManifest {
  schemaVersion: 1;
  sourceFileName: string;
  sourceSha256: string;
  readAt: string;
  sheets: WorkbookSheetManifest[];
  issues?: string[];
  stats?: Record<string, number>;
}

export interface WorkbookRowSelector {
  recordOrigin?: "source";
  sourceSha256: string;
  sheetName: string;
  sourceRow: number;
}

export interface WorkbookLocalRecordSelector {
  recordOrigin: "local_entry";
  localRecordId: string;
}

export type WorkbookRecordSelector = WorkbookRowSelector | WorkbookLocalRecordSelector;

export interface WorkbookManualRecord {
  recordOrigin: "local_entry";
  localRecordId: string;
  templateSourceSha256: string;
  sheetName: string;
  cells: Record<string, WorkbookCell>;
  createdAt: string;
  createdBy: string;
}

export type WorkbookRowUpdate = WorkbookRecordSelector & {
  id: string;
  coordinationStatus: WorkbookCoordinationStatus;
  collaborationNote: string | null;
  businessNote?: string | null;
  logisticsNote?: string | null;
  nextAction: string | null;
  nextActionDueAt: string | null;
  /** Sidecar corrections by Excel column key; source row cells remain immutable. */
  columnEdits: Record<string, string | null>;
  version: number;
  updatedAt: string;
  updatedBy: string;
};

export type WorkbookRowAudit = WorkbookRecordSelector & {
  id: string;
  action: "row.updated";
  changedFields: string[];
  reason: string;
  occurredAt: string;
  actorId: string;
};

export interface WorkbookRowCreateAudit extends WorkbookLocalRecordSelector {
  id: string;
  action: "row.created";
  changedFields: string[];
  reason: string;
  occurredAt: string;
  actorId: string;
}

export type WorkbookAuditEvent = WorkbookRowAudit | WorkbookRowCreateAudit;

export interface WorkbookLocalState {
  schemaVersion: 1;
  sourceManifests: WorkbookSourceManifest[];
  manualRecords: WorkbookManualRecord[];
  rowUpdates: WorkbookRowUpdate[];
  auditEvents: WorkbookAuditEvent[];
}

/** Constructed only by the local-business identity layer, never from request JSON. */
export interface LocalWorkbookActorBase {
  memberId: string;
  displayName: string;
}

export type LocalWorkbookActor =
  | (LocalWorkbookActorBase & { role: "local_manager" })
  | (LocalWorkbookActorBase & { role: "local_bd"; businessOwnerName: string })
  | (LocalWorkbookActorBase & { role: "local_shipping" })
  | (LocalWorkbookActorBase & { role: "local_links" });

export interface WorkbookListFilters {
  sourceSha256?: string;
  sheetName?: string;
  kind?: WorkbookSheetKind;
  platform?: WorkbookPlatform;
  year?: number;
  query?: string;
  businessOwner?: string;
  /** Match the original source-status cell; `__blank__` means missing/empty source value. */
  sourceStatus?: string;
  coordinationStatus?: WorkbookCoordinationStatus;
  fieldState?: WorkbookFieldState;
  includeHidden?: boolean;
  page?: number;
  pageSize?: number;
}

export interface WorkbookRowListItem {
  recordOrigin: WorkbookRecordOrigin;
  sourceSha256: string | null;
  templateSourceSha256: string | null;
  localRecordId: string | null;
  sheetName: string;
  sourceRow: number | null;
  sourceFileName: string | null;
  templateSourceFileName: string | null;
  kind: WorkbookSheetKind;
  year: number | null;
  platform: WorkbookPlatform;
  platformSourceValue: WorkbookCell;
  columns: WorkbookSourceColumn[];
  readableColumnKeys: string[];
  editableColumnKeys: string[];
  /** Role-scoped current display cells after sidecar overrides. */
  cells: Record<string, WorkbookCell>;
  sensitiveColumnKeys: string[];
  issues: string[];
  collaborationStatus: WorkbookCoordinationStatus;
  collaborationNote: string | null;
  businessNote: string | null;
  logisticsNote: string | null;
  nextAction: string | null;
  nextActionDueAt: string | null;
  columnEdits: Record<string, string | null>;
  version: number;
}

export interface WorkbookRowDetail extends WorkbookRowListItem {
  sourceReadAt: string | null;
  sourceSheetHidden: boolean;
  sensitiveValuesIncluded: boolean;
  /** Immutable baseline: source workbook values or the initial local-entry values. */
  baselineCells: Record<string, WorkbookCell>;
  /** Original workbook cells; empty for local-entry records. */
  sourceCells: Record<string, WorkbookCell>;
  sheetIssues: string[];
  auditEvents: WorkbookAuditEvent[];
}

export interface WorkbookListResult {
  rows: WorkbookRowListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface WorkbookSourceSummary {
  sourceFileName: string;
  sourceSha256: string;
  readAt: string;
  sheetCount: number;
  visibleSheetCount: number;
  rowCount: number;
  rowsWithIssues: number;
  years: number[];
  sheets: WorkbookSheetSummary[];
}

export interface WorkbookSourceStatusCount {
  value: string | "__blank__";
  count: number;
}

export interface WorkbookSheetSummary {
  sourceSha256: string;
  sheetName: string;
  kind: WorkbookSheetKind;
  year: number | null;
  hidden: boolean;
  rowCount: number;
  rowsWithIssues: number;
  columns: WorkbookSourceColumn[];
  readableColumnKeys: string[];
  editableColumnKeys: string[];
  manualCreateColumnKeys: string[];
  requiredManualCreateColumnKeys: string[];
  sourceStatusCounts: WorkbookSourceStatusCount[];
  businessOwners: string[];
}

export interface WorkbookSummary {
  sources: WorkbookSourceSummary[];
  sheets: WorkbookSheetSummary[];
  totals: { rows: number; sourceRows: number; manualRows: number; rowsWithIssues: number; visibleRows: number; hiddenRows: number };
  platformCounts: Record<WorkbookPlatform, number>;
  kindCounts: Record<WorkbookSheetKind, number>;
  sourceStatusCounts: WorkbookBreakdownCount[];
  businessOwnerCounts: WorkbookBreakdownCount[];
  /** Field completeness only; these counts do not mean a package shipped or a stream occurred. */
  operationalCounts: {
    samplesRows: number;
    sampleTrackingRecorded: number;
    sampleTrackingMissing: number;
    broadcastRows: number;
    broadcastLinkRecorded: number;
    broadcastLinkMissing: number;
  };
  /** Only explicit full dates from the `填表日期` column; never derived from sheet year or local-entry time. */
  fillDateCoverage: { rows: number; totalWithValidDate: number; missingOrInvalid: number };
  fillDateMonthlyCounts: Array<{ month: string; count: number }>;
  coordinationStatusCounts: Record<WorkbookCoordinationStatus, number>;
}

export interface WorkbookUpdatePatch {
  coordinationStatus?: WorkbookCoordinationStatus;
  collaborationNote?: string | null;
  businessNote?: string | null;
  logisticsNote?: string | null;
  nextAction?: string | null;
  nextActionDueAt?: string | null;
  columnEdits?: Record<string, string | null>;
}

export type WorkbookRowUpdateInput = WorkbookRecordSelector & {
  expectedVersion: number;
  reason: string;
  /** Required when editing a sensitive column such as a live-link/password cell. */
  revealedSensitiveColumnKeys?: string[];
  patch: WorkbookUpdatePatch;
};

export interface WorkbookRowCreateInput {
  templateSourceSha256: string;
  sheetName: string;
  cells: Record<string, WorkbookCell>;
  reason: string;
}

export interface WorkbookBreakdownCount {
  kind: WorkbookSheetKind;
  platform: WorkbookPlatform;
  value: string | "__blank__";
  count: number;
}
