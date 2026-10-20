import type {
  Creator,
  DomainState,
  Id,
  ManualStore,
  Product,
  SalesPerformanceReport,
  SalesPerformanceWorkspaceItem,
  ShanghaiDate,
} from "../../shared/types.ts";
import type { DomainCommand } from "../../shared/commands.ts";
import { requireManagerOrAdmin, type AuthContext } from "./auth.ts";
import { domainError } from "./errors.ts";
import {
  findPotentialOrderOverlaps,
  projectSalesPerformanceReport,
} from "../../shared/sales-performance.ts";
import {
  addAudit,
  assertIsoDateTime,
  assertValidCents,
  checkVersion,
  incrementVersion,
  normalizeKey,
  type DomainRuntime,
} from "./utils.ts";

type SalesReportCommand = Extract<DomainCommand, {
  type: "salesReport.create" | "salesReport.update"
    | "salesReport.review" | "salesReport.reconcile";
}>;

type SalesReportDataCommand = Extract<DomainCommand, {
  type: "salesReport.create" | "salesReport.update";
}>;

type SalesReportData = Omit<SalesPerformanceReport,
  "id" | "version" | "createdAt" | "createdBy" | "updatedAt"
    | "updatedBy" | "ownerMemberId" | "status" | "submittedAt"
    | "reviewedBy" | "reviewedAt" | "reviewNote" | "reconciledBy"
    | "reconciledAt" | "reconciliationNote">;

function reportForAction(
  state: DomainState,
  auth: AuthContext,
  reportId: Id,
): SalesPerformanceReport {
  const report = state.salesReports.find((item) =>
    item.id === reportId && item.orgId === state.orgId,
  );
  if (!report) domainError("NOT_FOUND", "带货业绩不存在或当前账号无权访问");
  if (auth.role !== "admin" && report.teamId !== auth.member.teamId) {
    domainError("NOT_FOUND", "带货业绩不存在或当前账号无权访问");
  }
  return report;
}

function requireNonOperationsRole(auth: AuthContext): void {
  if (auth.role === "ops") {
    domainError("FORBIDDEN", "样品运营账号不能维护商务带货业绩");
  }
}

function requireCreator(
  state: DomainState,
  auth: AuthContext,
  creatorId: Id,
): Creator {
  const creator = state.creators.find((item) =>
    item.id === creatorId && item.orgId === state.orgId && !item.archived,
  );
  if (!creator) domainError("NOT_FOUND", "达人不存在或当前账号无权访问");
  if (auth.role !== "admin" && creator.teamId !== auth.member.teamId) {
    domainError("NOT_FOUND", "达人不存在或当前账号无权访问");
  }
  if (auth.role === "bd" && creator.ownerMemberId !== auth.member.id) {
    domainError("NOT_FOUND", "商务只能填报本人负责的达人");
  }
  const team = state.teams.find((item) =>
    item.id === creator.teamId && item.orgId === creator.orgId && item.active,
  );
  if (!team) domainError("FORBIDDEN", "达人当前没有可访问的有效团队");
  return creator;
}

function requireStore(
  state: DomainState,
  auth: AuthContext,
  creator: Creator,
  storeId: Id,
): ManualStore {
  const store = state.manualStores.find((item) =>
    item.id === storeId && item.orgId === creator.orgId
      && item.teamId === creator.teamId && item.active,
  );
  if (!store) domainError("NOT_FOUND", "店铺不存在、已停用或不属于当前品牌团队");
  if (auth.role !== "admin" && store.teamId !== auth.member.teamId) {
    domainError("NOT_FOUND", "店铺不存在或当前账号无权访问");
  }
  return store;
}

function requireAccount(
  creator: Creator,
  accountId: Id,
  store: ManualStore,
): Creator["accounts"][number] {
  const account = creator.accounts.find((item) => item.id === accountId && item.active);
  if (!account) domainError("NOT_FOUND", "有效平台账号不存在或不属于当前达人");
  if (account.platform !== store.platform) {
    domainError("BUSINESS_RULE_VIOLATION", "达人账号平台必须与店铺平台一致");
  }
  return account;
}

function requireProducts(
  state: DomainState,
  auth: AuthContext,
  creator: Creator,
  productIds: Id[],
): Product[] {
  const uniqueIds = [...new Set(productIds)];
  if (uniqueIds.length === 0) domainError("VALIDATION_ERROR", "至少选择一个商品");
  return uniqueIds.map((productId: Id) => {
    const product = state.products.find((item) =>
      item.id === productId && item.orgId === creator.orgId && item.active,
    );
    if (!product || product.teamId !== creator.teamId) {
      domainError("NOT_FOUND", "商品不存在、已停用或不属于当前品牌团队");
    }
    if (auth.role !== "admin" && product.teamId !== auth.member.teamId) {
      domainError("NOT_FOUND", "商品不存在或当前账号无权访问");
    }
    return product;
  });
}

function shanghaiDate(value: string): ShanghaiDate {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function isShanghaiMidnight(value: string): boolean {
  const day = shanghaiDate(value);
  return Date.parse(value) === Date.parse(`${day}T00:00:00+08:00`);
}

function periodCreditDate(
  commerceType: SalesPerformanceReport["commerceType"],
  periodStartAt: string,
  periodEndAt: string,
  now: string,
): ShanghaiDate {
  assertIsoDateTime(periodStartAt, "统计开始时间");
  assertIsoDateTime(periodEndAt, "统计结束时间");
  const start = Date.parse(periodStartAt);
  const end = Date.parse(periodEndAt);
  const cutoff = Date.parse(now);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    domainError("BUSINESS_RULE_VIOLATION", "统计结束时间必须晚于开始时间");
  }
  if (!Number.isFinite(cutoff)) domainError("BUSINESS_RULE_VIOLATION", "系统当前时间无效");

  if (commerceType === "live") {
    if (end > cutoff) domainError("BUSINESS_RULE_VIOLATION", "直播实际结束时间不能晚于当前时间");
    return shanghaiDate(periodStartAt);
  }

  if (!isShanghaiMidnight(periodStartAt) || !isShanghaiMidnight(periodEndAt)) {
    domainError("BUSINESS_RULE_VIOLATION", "短视频统计周期必须使用上海时区的自然日边界");
  }
  const firstDay = shanghaiDate(periodStartAt);
  const lastDay = shanghaiDate(new Date(end - 1).toISOString());
  if (firstDay.slice(0, 7) !== lastDay.slice(0, 7)) {
    domainError("BUSINESS_RULE_VIOLATION", "短视频统计周期需按自然月分段填报");
  }
  if (lastDay > shanghaiDate(now)) {
    domainError("BUSINESS_RULE_VIOLATION", "短视频统计周期不能包含今天之后的日期");
  }
  return lastDay;
}

function assertEvidence(
  evidenceUrl: string | null,
  evidenceNote: string | null,
): void {
  if (!evidenceUrl && !evidenceNote?.trim()) {
    domainError("BUSINESS_RULE_VIOLATION", "请提供数据凭证链接或说明");
  }
}

function hasSameFrozenIdentity(
  report: SalesPerformanceReport,
  command: SalesReportDataCommand,
): boolean {
  const productIds = [...new Set(command.productIds)].sort();
  const reportProductIds = [...new Set(report.productIds)].sort();
  const contentId = command.contentId === undefined
    ? report.contentId
    : command.contentId?.trim() || null;
  return command.creatorId === report.creatorId
    && command.creatorAccountId === report.creatorAccountId
    && command.storeId === report.storeId
    && command.commerceType === report.commerceType
    && contentId === report.contentId
    && productIds.length === reportProductIds.length
    && productIds.every((productId: Id, index: number) => productId === reportProductIds[index])
    && command.periodStartAt === report.periodStartAt
    && command.periodEndAt === report.periodEndAt;
}

function correctedFrozenReportData(
  report: SalesPerformanceReport,
  command: SalesReportDataCommand,
  allowContentUrlChange: boolean,
): SalesReportData {
  assertValidCents(command.gmvCents, "成交金额");
  const evidenceUrl = command.evidenceUrl === undefined
    ? report.evidenceUrl
    : command.evidenceUrl;
  const evidenceNote = command.evidenceNote === undefined
    ? report.evidenceNote
    : command.evidenceNote?.trim() || null;
  assertEvidence(evidenceUrl, evidenceNote);
  return {
    orgId: report.orgId,
    teamId: report.teamId,
    creatorId: report.creatorId,
    creatorAccountId: report.creatorAccountId,
    platform: report.platform,
    externalAccountId: report.externalAccountId,
    storeId: report.storeId,
    shopId: report.shopId,
    commerceType: report.commerceType,
    title: command.title,
    contentId: report.contentId,
    contentUrl: allowContentUrlChange && command.contentUrl !== undefined
      ? command.contentUrl
      : report.contentUrl,
    productIds: [...report.productIds],
    periodStartAt: report.periodStartAt,
    periodEndAt: report.periodEndAt,
    creditedOn: report.creditedOn,
    gmvCents: command.gmvCents,
    orderCount: command.orderCount === undefined ? report.orderCount : command.orderCount,
    evidenceUrl,
    evidenceNote,
  };
}

function assertNoManualDuplicate(
  state: DomainState,
  candidate: Pick<SalesPerformanceReport,
    "id" | "orgId" | "teamId" | "platform" | "shopId"
    | "externalAccountId" | "commerceType" | "contentId"
    | "periodStartAt" | "periodEndAt">,
): void {
  const start = Date.parse(candidate.periodStartAt);
  const end = Date.parse(candidate.periodEndAt);
  const duplicate = state.salesReports.find((item) => {
    if (item.id === candidate.id || item.orgId !== candidate.orgId
      || item.teamId !== candidate.teamId || item.platform !== candidate.platform
      || item.shopId !== candidate.shopId
      || item.externalAccountId !== candidate.externalAccountId) return false;
    if (item.commerceType !== candidate.commerceType) return false;
    if (candidate.commerceType === "short_video" && item.contentId !== candidate.contentId) return false;
    return Date.parse(item.periodStartAt) < end && start < Date.parse(item.periodEndAt);
  });
  if (duplicate) {
    domainError("DUPLICATE", "该达人账号的填报周期已存在，请更新原记录，避免重复计数");
  }
}

function dataFromCommand(
  state: DomainState,
  auth: AuthContext,
  command: SalesReportDataCommand,
  runtime: DomainRuntime,
): SalesReportData {
  const creator = requireCreator(state, auth, command.creatorId);
  const store = requireStore(state, auth, creator, command.storeId);
  const account = requireAccount(creator, command.creatorAccountId, store);
  const products = requireProducts(state, auth, creator, command.productIds);
  const creditedOn = periodCreditDate(
    command.commerceType,
    command.periodStartAt,
    command.periodEndAt,
    runtime.now(),
  );
  assertValidCents(command.gmvCents, "成交金额");
  const evidenceUrl = command.evidenceUrl ?? null;
  const evidenceNote = command.evidenceNote?.trim() || null;
  assertEvidence(evidenceUrl, evidenceNote);
  if (command.commerceType === "short_video" && !command.contentId?.trim()) {
    domainError("BUSINESS_RULE_VIOLATION", "短视频填报必须提供稳定的视频 ID");
  }

  return {
    orgId: creator.orgId,
    teamId: creator.teamId,
    creatorId: creator.id,
    creatorAccountId: account.id,
    platform: account.platform,
    externalAccountId: normalizeKey(account.externalAccountId),
    storeId: store.id,
    shopId: normalizeKey(store.externalShopId),
    commerceType: command.commerceType,
    title: command.title,
    contentId: command.contentId?.trim() || null,
    contentUrl: command.contentUrl ?? null,
    productIds: products.map((item: Product) => item.id),
    periodStartAt: command.periodStartAt,
    periodEndAt: command.periodEndAt,
    creditedOn,
    gmvCents: command.gmvCents,
    orderCount: command.orderCount ?? null,
    evidenceUrl,
    evidenceNote,
  };
}

function createReport(
  state: DomainState,
  auth: AuthContext,
  command: Extract<DomainCommand, { type: "salesReport.create" }>,
  runtime: DomainRuntime,
): SalesPerformanceReport {
  requireNonOperationsRole(auth);
  const data = dataFromCommand(state, auth, command, runtime);
  const now = runtime.now();
  const report: SalesPerformanceReport = {
    ...data,
    id: runtime.id("sales-report"),
    ownerMemberId: auth.member.id,
    status: "pending_review",
    submittedAt: now,
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    reconciledBy: null,
    reconciledAt: null,
    reconciliationNote: null,
    version: 1,
    createdAt: now,
    createdBy: auth.member.id,
    updatedAt: now,
    updatedBy: auth.member.id,
  };
  assertNoManualDuplicate(state, report);
  state.salesReports.push(report);
  addAudit(state, runtime, auth.member.id, report, "sales_report", report.id,
    "sales_report.created", null, null, {
      creatorId: report.creatorId,
      platform: report.platform,
      commerceType: report.commerceType,
      storeId: report.storeId,
      productIds: report.productIds,
      periodStartAt: report.periodStartAt,
      periodEndAt: report.periodEndAt,
      creditedOn: report.creditedOn,
      gmvCents: report.gmvCents,
      status: report.status,
      ownerMemberId: report.ownerMemberId,
    });
  return structuredClone(report);
}

function updateReport(
  state: DomainState,
  auth: AuthContext,
  command: Extract<DomainCommand, { type: "salesReport.update" }>,
  runtime: DomainRuntime,
): SalesPerformanceReport {
  requireNonOperationsRole(auth);
  const report = reportForAction(state, auth, command.reportId);
  if (report.ownerMemberId !== auth.member.id || report.createdBy !== auth.member.id) {
    domainError("NOT_FOUND", "带货业绩不存在或当前账号无权访问");
  }
  checkVersion(report, command.expectedVersion);
  if (report.status !== "pending_review" && report.status !== "returned") {
    domainError("INVALID_TRANSITION", "只有待核对或已退回的本人填报可以修改");
  }
  if (report.reconciledBy !== null || report.reconciledAt !== null) {
    domainError("INVALID_TRANSITION", "已由订单明细覆盖的业绩属于终态，不能重新提交");
  }
  const currentCreator = state.creators.find((item) =>
    item.id === report.creatorId && item.orgId === report.orgId && !item.archived,
  );
  const stillResponsible = auth.role !== "bd"
    || currentCreator?.ownerMemberId === auth.member.id;
  if (!stillResponsible && !hasSameFrozenIdentity(report, command)) {
    domainError("FORBIDDEN", "达人已转交；只能更正原填报的金额、订单数、凭证和说明，不能改关联对象或统计周期");
  }
  const data = hasSameFrozenIdentity(report, command)
    ? correctedFrozenReportData(report, command, stillResponsible)
    : dataFromCommand(state, auth, command, runtime);
  const before = {
    creatorId: report.creatorId,
    creatorAccountId: report.creatorAccountId,
    storeId: report.storeId,
    productIds: report.productIds,
    periodStartAt: report.periodStartAt,
    periodEndAt: report.periodEndAt,
    gmvCents: report.gmvCents,
    status: report.status,
  };
  Object.assign(report, data);
  report.status = "pending_review";
  report.submittedAt = runtime.now();
  report.reviewedBy = null;
  report.reviewedAt = null;
  report.reviewNote = null;
  report.reconciledBy = null;
  report.reconciledAt = null;
  report.reconciliationNote = null;
  incrementVersion(report, runtime.now(), auth.member.id);
  assertNoManualDuplicate(state, report);
  addAudit(state, runtime, auth.member.id, report, "sales_report", report.id,
    "sales_report.resubmitted", null, before, {
      creatorId: report.creatorId,
      creatorAccountId: report.creatorAccountId,
      storeId: report.storeId,
      productIds: report.productIds,
      periodStartAt: report.periodStartAt,
      periodEndAt: report.periodEndAt,
      gmvCents: report.gmvCents,
      status: report.status,
      ownerMemberId: report.ownerMemberId,
    });
  return structuredClone(report);
}

function reviewReport(
  state: DomainState,
  auth: AuthContext,
  command: Extract<DomainCommand, { type: "salesReport.review" }>,
  runtime: DomainRuntime,
): SalesPerformanceReport {
  requireManagerOrAdmin(auth, "只有负责人或管理员可以核对带货业绩");
  const report = reportForAction(state, auth, command.reportId);
  if (report.ownerMemberId === auth.member.id || report.createdBy === auth.member.id) {
    domainError("FORBIDDEN", "填报人不能核对自己的业绩");
  }
  checkVersion(report, command.expectedVersion);
  const mayApprove = report.status === "pending_review" && command.decision === "approved";
  const mayReturn = (report.status === "pending_review" || report.status === "approved")
    && command.decision === "returned";
  if (!mayApprove && !mayReturn) {
    domainError("INVALID_TRANSITION", "当前业绩状态不能执行此核对操作");
  }
  if (report.reconciledBy !== null || report.reconciledAt !== null) {
    domainError("INVALID_TRANSITION", "已由订单明细覆盖的业绩属于终态，不能再次核对");
  }
  const reason = command.reason?.trim() || null;
  if (command.decision === "returned" && !reason) {
    domainError("BUSINESS_RULE_VIOLATION", "退回业绩必须填写原因");
  }
  const before = {
    status: report.status,
    reviewedBy: report.reviewedBy,
    reviewedAt: report.reviewedAt,
    reviewNote: report.reviewNote,
    reconciledBy: report.reconciledBy,
  };
  report.status = command.decision;
  report.reviewedBy = auth.member.id;
  report.reviewedAt = runtime.now();
  report.reviewNote = reason;
  if (command.decision === "returned") {
    report.reconciledBy = null;
    report.reconciledAt = null;
    report.reconciliationNote = null;
  }
  incrementVersion(report, runtime.now(), auth.member.id);
  addAudit(state, runtime, auth.member.id, report, "sales_report", report.id,
    `sales_report.${command.decision}`, reason, before, {
      status: report.status,
      reviewedBy: report.reviewedBy,
      reviewedAt: report.reviewedAt,
      reconciliationCleared: command.decision === "returned",
    });
  return structuredClone(report);
}

function reconcileReport(
  state: DomainState,
  auth: AuthContext,
  command: Extract<DomainCommand, { type: "salesReport.reconcile" }>,
  runtime: DomainRuntime,
): SalesPerformanceReport {
  requireManagerOrAdmin(auth, "只有负责人或管理员可以核对订单覆盖情况");
  const report = reportForAction(state, auth, command.reportId);
  if (report.ownerMemberId === auth.member.id || report.createdBy === auth.member.id) {
    domainError("FORBIDDEN", "填报人不能确认自己的订单覆盖情况");
  }
  checkVersion(report, command.expectedVersion);
  if (report.status !== "approved") {
    domainError("INVALID_TRANSITION", "只有已通过的业绩可以确认订单覆盖");
  }
  if (report.reconciledBy !== null || report.reconciledAt !== null) {
    domainError("INVALID_TRANSITION", "该业绩已确认由订单明细覆盖");
  }
  const overlapCount = findPotentialOrderOverlaps(report, state.orders).length;
  if (overlapCount === 0) {
    domainError("BUSINESS_RULE_VIOLATION", "尚无可能重叠的订单，不能确认订单完整覆盖");
  }
  const before = {
    status: report.status,
    reconciledBy: report.reconciledBy,
    overlappingOrderCount: overlapCount,
  };
  report.reconciledBy = auth.member.id;
  report.reconciledAt = runtime.now();
  report.reconciliationNote = command.reason.trim();
  incrementVersion(report, runtime.now(), auth.member.id);
  addAudit(state, runtime, auth.member.id, report, "sales_report", report.id,
    "sales_report.orders_confirmed_as_complete_coverage", command.reason,
    before, {
      reconciledBy: report.reconciledBy,
      reconciledAt: report.reconciledAt,
      overlappingOrderCount: overlapCount,
      manualGmvExcluded: true,
    });
  return structuredClone(report);
}

export function executeSalesPerformanceCommand(
  state: DomainState,
  auth: AuthContext,
  command: SalesReportCommand,
  runtime: DomainRuntime,
): SalesPerformanceReport {
  switch (command.type) {
    case "salesReport.create":
      return createReport(state, auth, command, runtime);
    case "salesReport.update":
      return updateReport(state, auth, command, runtime);
    case "salesReport.review":
      return reviewReport(state, auth, command, runtime);
    case "salesReport.reconcile":
      return reconcileReport(state, auth, command, runtime);
  }
}

export function projectSalesPerformanceWorkspace(
  state: DomainState,
  auth: AuthContext,
  teamId: Id | null,
  ownerMemberId: Id | undefined,
  dateFrom: ShanghaiDate | undefined,
  dateTo: ShanghaiDate | undefined,
  search: string,
): SalesPerformanceWorkspaceItem[] {
  if (auth.role === "ops") return [];
  const needle = search.toLocaleLowerCase();
  const canSeeOverlapCount = auth.role === "admin" || auth.role === "manager";
  return state.salesReports
    .map((report) => projectSalesPerformanceReport(
      report,
      state.orders,
      canSeeOverlapCount,
    ))
    .filter((report) => report.orgId === state.orgId
      && (teamId === null ? auth.role === "admin" || report.teamId === auth.member.teamId : report.teamId === teamId)
      && (auth.role !== "bd" || report.ownerMemberId === auth.member.id)
      && (!ownerMemberId || report.ownerMemberId === ownerMemberId)
      && (!dateFrom || report.creditedOn >= dateFrom)
      && (!dateTo || report.creditedOn <= dateTo)
      && (!needle || report.title.toLocaleLowerCase().includes(needle)
        || report.externalAccountId.toLocaleLowerCase().includes(needle)
        || (report.contentId ?? "").toLocaleLowerCase().includes(needle)))
    .map((report) => structuredClone(report));
}
