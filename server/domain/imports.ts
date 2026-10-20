import type {
  ImportBatch,
  ImportCreatorRow,
  ImportIssue,
  ImportOrderRow,
  ImportPreviewResult,
  ImportRefundRow,
  Member,
  OrderLine,
  RefundEvent,
  Role,
  Capability,
  Platform,
} from "../../shared/types.ts";
import type { ImportCommitCommand, ImportPreviewCommand } from "../../shared/commands.ts";
import type { DomainRuntime } from "./utils.ts";
import { addAudit, addCents, fingerprint, normalizeKey, stableStringify } from "./utils.ts";
import { domainError } from "./errors.ts";
import type { DomainState } from "../../shared/types.ts";

export type ImportCommand = ImportPreviewCommand | ImportCommitCommand;

export function creatorIdsInMergeFamily(state: DomainState, creatorId: string): Set<string> {
  const canonical = (id: string): string => {
    let current = id;
    const seen = new Set<string>();
    while (!seen.has(current)) {
      seen.add(current);
      const creator = state.creators.find((item) => item.id === current);
      if (!creator?.mergedIntoCreatorId) return current;
      current = creator.mergedIntoCreatorId;
    }
    return current;
  };
  const root = canonical(creatorId);
  return new Set(state.creators.filter((creator) => canonical(creator.id) === root).map((creator) => creator.id));
}

interface EvaluatedImport {
  result: ImportPreviewResult;
  creatorRows: ImportCreatorRow[];
  orderRows: ImportOrderRow[];
  refundRows: ImportRefundRow[];
}

export function importFingerprint(command: ImportCommand): string {
  return fingerprint({
    sourceName: command.sourceName,
    creators: command.creators.map((row) => ({ ...row, platform: importPlatform(row) })),
    orders: command.orders.map(fingerprintPlatformRow),
    refunds: command.refunds.map(fingerprintPlatformRow),
  });
}

export function previewImport(state: DomainState, member: Member, role: Role, capabilities: Capability[], command: ImportCommand): ImportPreviewResult {
  authorizeImport(role, capabilities);
  const existingBatch = state.importBatches.find((batch) => batch.id === command.batchId);
  const payloadFingerprint = importFingerprint(command);
  if (existingBatch && existingBatch.payloadFingerprint !== payloadFingerprint) {
    domainError("IMPORT_CONFLICT", "导入批次编号已用于不同内容，请重新生成预览批次");
  }
  if (existingBatch) return resultFromBatch(existingBatch, command);
  return evaluateImport(state, member, role, capabilities, command).result;
}

export function commitImport(
  state: DomainState,
  member: Member,
  role: Role,
  capabilities: Capability[],
  command: ImportCommitCommand,
  runtime: DomainRuntime,
): { result: ImportPreviewResult; batch: ImportBatch; replayed: boolean } {
  authorizeImport(role, capabilities);
  const payloadFingerprint = importFingerprint(command);
  const priorBatch = state.importBatches.find((batch) => batch.id === command.batchId);
  if (priorBatch) {
    if (priorBatch.payloadFingerprint !== payloadFingerprint) domainError("IMPORT_CONFLICT", "导入批次编号已用于不同内容，拒绝覆盖既有批次");
    return { result: resultFromBatch(priorBatch, command), batch: priorBatch, replayed: true };
  }

  const evaluated = evaluateImport(state, member, role, capabilities, command);
  const creatorIssues = new Set(evaluated.result.issues.filter((issue) => issue.entity === "creator").map((issue) => issue.rowNumber));
  const orderIssues = new Set(evaluated.result.issues.filter((issue) => issue.entity === "order").map((issue) => issue.rowNumber));
  const refundIssues = new Set(evaluated.result.issues.filter((issue) => issue.entity === "refund").map((issue) => issue.rowNumber));
  const now = runtime.now();

  const committedCreators = new Map<string, string>();
  const createdCreatorIds = new Set<string>();
  for (const row of evaluated.creatorRows) {
    if (creatorIssues.has(row.rowNumber)) continue;
    const key = accountKey(row.platform, row.externalAccountId);
    if (committedCreators.has(key)) continue;
    const existing = findCreatorAccount(state, row.platform, row.externalAccountId);
    if (existing) {
      committedCreators.set(key, existing.id);
      continue;
    }
    const creatorId = runtime.id("creator");
    const internalAccountId = runtime.id("account");
    const creator = {
      id: creatorId, orgId: member.orgId, teamId: member.teamId, name: row.name, category: row.category,
      tags: row.tags, source: row.source,
      accounts: [{ id: internalAccountId, platform: row.platform, externalAccountId: normalizeKey(row.externalAccountId), displayName: row.displayName, profileUrl: row.profileUrl, active: true, firstSeenAt: now, lastVerifiedAt: null }],
      ownerMemberId: null, crmStage: "uncontacted" as const, pausedFromStage: null, pauseReason: null, reviewAt: null,
      declineReason: null, contact: row.contact, internalNote: null, archived: false, mergedIntoCreatorId: null,
      version: 1, createdAt: now, createdBy: member.id, updatedAt: now, updatedBy: member.id,
    };
    state.creators.push(creator);
    state.ownerAssignments.push({ id: runtime.id("owner"), creatorId, orgId: member.orgId, teamId: member.teamId, memberId: null, validFrom: now, validTo: null, changedBy: member.id, reason: "导入进入公海" });
    state.creatorStageEvents.push({ id: runtime.id("stage"), creatorId, orgId: member.orgId, teamId: member.teamId, stage: "uncontacted", occurredAt: now, recordedAt: now, actorId: member.id, reason: "CSV 导入" });
    committedCreators.set(key, creatorId);
    createdCreatorIds.add(creatorId);
    addAudit(state, runtime, member.id, member, "creator", creatorId, "creator.imported", "CSV 导入", null, { name: row.name, externalAccountId: row.externalAccountId });
  }

  const acceptedOrders = new Set<string>();
  for (const row of evaluated.orderRows) {
    if (orderIssues.has(row.rowNumber)) continue;
    const platform = importPlatform(row);
    const key = orderKey(platform, row.shopId, row.externalOrderId, row.externalLineId);
    const existing = state.orders.find((order) => orderKey(order.platform, order.shopId, order.externalOrderId, order.externalLineId) === key);
    if (existing) continue;
    const creatorId = resolveImportedCreator(state, committedCreators, platform, row.creatorAccountId);
    const creator = creatorId ? state.creators.find((item) => item.id === creatorId) ?? null : null;
    const assignment = creator && row.status === "paid" && row.paidAt ? ownerAt(state, creator.id, row.paidAt) : null;
    const reason = row.status !== "paid" ? "payment_not_finalized" as const : !creator ? "creator_unmatched" as const : assignment === "ambiguous" ? "ambiguous_owner" as const : !assignment ? "no_owner_at_paid_at" as const : "matched" as const;
    const ownerId = assignment && assignment !== "ambiguous" ? assignment.memberId : null;
    const order: OrderLine = {
      id: runtime.id("order"), orgId: member.orgId, teamId: creator?.teamId ?? member.teamId,
      platform, shopId: row.shopId, externalOrderId: normalizeKey(row.externalOrderId), externalLineId: normalizeKey(row.externalLineId),
      productId: resolveImportedProductId(state, member, creator?.teamId ?? member.teamId, row),
      sku: row.sku, creatorAccountId: row.creatorAccountId, creatorId, paidAt: row.paidAt, sourceStatus: row.sourceStatus,
      status: row.status, paidAmountCents: row.paidAmountCents, rawAmount: row.rawAmount,
      ownerSnapshot: { memberId: ownerId, assignedAt: assignment && assignment !== "ambiguous" ? assignment.validFrom : null, ruleVersion: "paid_at_owner_v1", reason },
      sourceEvidenceUrl: null,
      importBatchId: command.batchId, sourceRowNumber: row.rowNumber,
      contentFingerprint: orderFingerprint(row), createdAt: now, createdBy: member.id, updatedAt: now, updatedBy: member.id, version: 1,
    };
    state.orders.push(order);
    acceptedOrders.add(key);
  }

  const acceptedRefunds = new Set<string>();
  for (const row of evaluated.refundRows) {
    if (refundIssues.has(row.rowNumber)) continue;
    const platform = importPlatform(row);
    const order = state.orders.find((item) => item.platform === platform && item.shopId === row.shopId && item.externalOrderId === normalizeKey(row.externalOrderId) && item.externalLineId === normalizeKey(row.externalLineId));
    if (!order) continue;
    const stableRefundKey = refundKey(platform, row.shopId, row.externalRefundId);
    const exists = state.refunds.some((refund) => refundKey(refund.platform, refund.shopId, refund.externalRefundId) === stableRefundKey);
    if (exists) continue;
    state.refunds.push({
      id: runtime.id("refund"), orgId: member.orgId, teamId: order.teamId,
      platform, shopId: row.shopId, externalRefundId: normalizeKey(row.externalRefundId), orderLineId: order.id,
      refundedAt: row.refundedAt, sourceStatus: row.sourceStatus, status: row.status, amountCents: row.amountCents,
      direction: row.direction, rawAmount: row.rawAmount, importBatchId: command.batchId, sourceRowNumber: row.rowNumber,
      contentFingerprint: refundFingerprint(row), sourceEvidenceUrl: null, createdAt: now, createdBy: member.id, version: 1,
    });
    acceptedRefunds.add(stableRefundKey);
  }

  const kind: ImportBatch["kind"] = evaluated.result.totals.creators && (evaluated.result.totals.orders || evaluated.result.totals.refunds)
    ? "mixed"
    : evaluated.result.totals.creators ? "creators" : "orders_and_refunds";
  const batch: ImportBatch = {
    id: command.batchId, orgId: member.orgId, teamId: member.teamId, kind,
    sourceName: command.sourceName, payloadFingerprint, status: evaluated.result.issues.length ? "committed_with_issues" : "committed",
    createdAt: now, createdBy: member.id,
    acceptedCreators: createdCreatorIds.size,
    duplicateCreators: evaluated.result.duplicates.creators,
    acceptedOrders: acceptedOrders.size, duplicateOrders: evaluated.result.duplicates.orders,
    acceptedRefunds: acceptedRefunds.size, duplicateRefunds: evaluated.result.duplicates.refunds,
    issues: evaluated.result.issues,
  };
  state.importBatches.push(batch);
  addAudit(state, runtime, member.id, member, "import", batch.id, "import.committed", `CSV 导入：${command.sourceName}`, null, {
    acceptedCreators: batch.acceptedCreators, duplicateCreators: batch.duplicateCreators,
    acceptedOrders: batch.acceptedOrders, duplicateOrders: batch.duplicateOrders,
    acceptedRefunds: batch.acceptedRefunds, duplicateRefunds: batch.duplicateRefunds, issues: batch.issues.length,
  });
  const result = resultFromBatch(batch, command);
  return { result, batch, replayed: false };
}

function evaluateImport(state: DomainState, member: Member, role: Role, capabilities: Capability[], command: ImportCommand): EvaluatedImport {
  authorizeImport(role, capabilities);
  if (command.creators.length + command.orders.length + command.refunds.length === 0) domainError("VALIDATION_ERROR", "导入文件没有可处理的数据行");
  const issues: ImportIssue[] = [];
  const duplicateCreators = new Set<number>();
  const duplicateOrders = new Set<number>();
  const duplicateRefunds = new Set<number>();
  const rowIssues = new Set<string>();

  const seenAccounts = new Map<string, ImportCreatorRow>();
  for (const row of command.creators) {
    const platform = importPlatform(row);
    const key = accountKey(platform, row.externalAccountId);
    const earlier = seenAccounts.get(key);
    if (!normalizeKey(row.externalAccountId)) {
      addIssue(issues, rowIssues, { rowNumber: row.rowNumber, entity: "creator", key: null, code: "missing_identity", message: "缺少稳定平台账号 ID", existingId: null });
      continue;
    }
    if (earlier) {
      const priorIssue = issues.find((issue) => issue.entity === "creator" && issue.rowNumber === earlier.rowNumber);
      if (priorIssue) inheritIssue(issues, rowIssues, priorIssue, row.rowNumber);
      else if (stableStringify(stripRowNumber(earlier)) === stableStringify(stripRowNumber(row))) duplicateCreators.add(row.rowNumber);
      else addIssue(issues, rowIssues, { rowNumber: row.rowNumber, entity: "creator", key, code: "creator_identity_conflict", message: "同一批次出现相同账号 ID 但资料不同，请拆分核对", existingId: null });
      continue;
    }
    seenAccounts.set(key, row);
    const existing = findCreatorAccount(state, platform, row.externalAccountId);
    if (existing) {
      if (role !== "admin" && existing.teamId !== member.teamId) {
        addIssue(issues, rowIssues, { rowNumber: row.rowNumber, entity: "creator", key: null, code: "invalid_row", message: "该行无法在当前团队范围内匹配，请核对身份或联系管理员", existingId: null });
        continue;
      }
      if (creatorImportMatches(existing, row)) duplicateCreators.add(row.rowNumber);
      else addIssue(issues, rowIssues, { rowNumber: row.rowNumber, entity: "creator", key, code: "creator_identity_conflict", message: "该稳定账号已映射到现有达人，但资料不同；为保护历史负责人和联系方式，本次不覆盖", existingId: existing.id });
    }
  }

  const seenOrderKeys = new Map<string, ImportOrderRow>();
  for (const row of command.orders) {
    const platform = importPlatform(row);
    const key = orderKey(platform, row.shopId, row.externalOrderId, row.externalLineId);
    if (!row.externalOrderId.trim() || !row.externalLineId.trim()) {
      addIssue(issues, rowIssues, { rowNumber: row.rowNumber, entity: "order", key: null, code: "missing_identity", message: "缺少订单 ID 或订单行 ID，不能安全去重", existingId: null });
      continue;
    }
    if (row.status === "paid" && !row.paidAt) {
      addIssue(issues, rowIssues, { rowNumber: row.rowNumber, entity: "order", key, code: "missing_date", message: "已支付订单缺少支付时间，不能纳入业绩统计", existingId: null });
      continue;
    }
    const existing = state.orders.find((order) => orderKey(order.platform, order.shopId, order.externalOrderId, order.externalLineId) === key);
    if (role !== "admin" && existing && existing.teamId !== member.teamId) {
      addIssue(issues, rowIssues, { rowNumber: row.rowNumber, entity: "order", key: null, code: "invalid_row", message: "该行无法在当前团队范围内匹配，请核对身份或联系管理员", existingId: null });
      continue;
    }
    const mappedCreator = row.creatorAccountId ? findCreatorAccount(state, platform, row.creatorAccountId) : null;
    if (role !== "admin" && mappedCreator && mappedCreator.teamId !== member.teamId) {
      addIssue(issues, rowIssues, { rowNumber: row.rowNumber, entity: "order", key: null, code: "invalid_row", message: "该行无法在当前团队范围内匹配，请核对身份或联系管理员", existingId: null });
      continue;
    }
    const earlier = seenOrderKeys.get(key);
    if (earlier) {
      const priorIssue = issues.find((issue) => issue.entity === "order" && issue.rowNumber === earlier.rowNumber);
      if (priorIssue) inheritIssue(issues, rowIssues, priorIssue, row.rowNumber);
      else if (stableStringify(stripRowNumber(earlier)) === stableStringify(stripRowNumber(row))) duplicateOrders.add(row.rowNumber);
      else addIssue(issues, rowIssues, { rowNumber: row.rowNumber, entity: "order", key, code: "duplicate_in_batch", message: "同一批次存在同键但内容冲突的订单行", existingId: null });
      continue;
    }
    seenOrderKeys.set(key, row);
    if (existing) {
      if (existing.contentFingerprint === orderFingerprint(row)) duplicateOrders.add(row.rowNumber);
      else addIssue(issues, rowIssues, { rowNumber: row.rowNumber, entity: "order", key, code: "conflicting_replay", message: "订单稳定键已存在，但金额、日期或状态不同，需复核后再更正", existingId: existing.id });
    }
  }

  const seenRefundKeys = new Map<string, ImportRefundRow>();
  const candidateRefundTotals = new Map<string, number>();
  const refundsByEventTime = command.refunds.slice().sort((a, b) => {
    const left = a.refundedAt ? Date.parse(a.refundedAt) : Number.POSITIVE_INFINITY;
    const right = b.refundedAt ? Date.parse(b.refundedAt) : Number.POSITIVE_INFINITY;
    return left - right || a.rowNumber - b.rowNumber;
  });
  for (const row of refundsByEventTime) {
    const platform = importPlatform(row);
    const key = refundKey(platform, row.shopId, row.externalRefundId);
    if (!row.externalRefundId.trim()) {
      addIssue(issues, rowIssues, { rowNumber: row.rowNumber, entity: "refund", key: null, code: "missing_identity", message: "缺少退款事件稳定 ID，不能安全去重", existingId: null });
      continue;
    }
    if (row.status === "succeeded" && !row.refundedAt) {
      addIssue(issues, rowIssues, { rowNumber: row.rowNumber, entity: "refund", key, code: "missing_date", message: "成功退款缺少退款时间", existingId: null });
      continue;
    }
    const orderKeyValue = orderKey(platform, row.shopId, row.externalOrderId, row.externalLineId);
    const scopedExistingOrder = state.orders.find((item) => orderKey(item.platform, item.shopId, item.externalOrderId, item.externalLineId) === orderKeyValue);
    if (role !== "admin" && scopedExistingOrder && scopedExistingOrder.teamId !== member.teamId) {
      addIssue(issues, rowIssues, { rowNumber: row.rowNumber, entity: "refund", key: null, code: "invalid_row", message: "该行无法在当前团队范围内匹配，请核对身份或联系管理员", existingId: null });
      continue;
    }
    const earlier = seenRefundKeys.get(key);
    if (earlier) {
      const priorIssue = issues.find((issue) => issue.entity === "refund" && issue.rowNumber === earlier.rowNumber);
      if (priorIssue) inheritIssue(issues, rowIssues, priorIssue, row.rowNumber);
      else if (stableStringify(stripRowNumber(earlier)) === stableStringify(stripRowNumber(row))) duplicateRefunds.add(row.rowNumber);
      else addIssue(issues, rowIssues, { rowNumber: row.rowNumber, entity: "refund", key, code: "duplicate_in_batch", message: "同一批次存在同键但内容冲突的退款事件", existingId: null });
      continue;
    }
    seenRefundKeys.set(key, row);
    const existingRefund = state.refunds.find((refund) => refundKey(refund.platform, refund.shopId, refund.externalRefundId) === key);
    if (existingRefund) {
      if (role !== "admin" && existingRefund.teamId !== member.teamId) {
        addIssue(issues, rowIssues, { rowNumber: row.rowNumber, entity: "refund", key: null, code: "invalid_row", message: "该行无法在当前团队范围内匹配，请核对身份或联系管理员", existingId: null });
      } else if (existingRefund.contentFingerprint === refundFingerprint(row)) duplicateRefunds.add(row.rowNumber);
      else addIssue(issues, rowIssues, { rowNumber: row.rowNumber, entity: "refund", key, code: "conflicting_replay", message: "退款稳定键已存在，但金额、日期或状态不同，需复核", existingId: existingRefund.id });
      continue;
    }
    const candidateOrderRow = command.orders.find((item) => orderKey(importPlatform(item), item.shopId, item.externalOrderId, item.externalLineId) === orderKeyValue && !rowIssues.has(`order:${item.rowNumber}`)) ?? null;
    const order = scopedExistingOrder ?? candidateOrderRow;
    if (!order) {
      addIssue(issues, rowIssues, { rowNumber: row.rowNumber, entity: "refund", key, code: "order_not_found", message: "退款关联不到已导入或本批次有效订单行", existingId: null });
      continue;
    }
    if (row.status === "succeeded" && (order.status !== "paid" || !order.paidAt)) {
      addIssue(issues, rowIssues, { rowNumber: row.rowNumber, entity: "refund", key, code: "invalid_row", message: "关联订单尚未确认支付，成功退款暂不写入，请先核对订单来源", existingId: typeof order === "object" && "id" in order ? order.id : null });
      continue;
    }
    if (row.status === "succeeded" && row.refundedAt && order.paidAt && Date.parse(row.refundedAt) < Date.parse(order.paidAt)) {
      addIssue(issues, rowIssues, { rowNumber: row.rowNumber, entity: "refund", key, code: "invalid_row", message: "成功退款时间不能早于关联订单的支付时间", existingId: null });
      continue;
    }
    if (role !== "admin" && candidateOrderRow && candidateOrderRow.creatorAccountId) {
      const creator = findCreatorAccount(state, importPlatform(candidateOrderRow), candidateOrderRow.creatorAccountId);
      if (creator && creator.teamId !== member.teamId) {
        addIssue(issues, rowIssues, { rowNumber: row.rowNumber, entity: "refund", key: null, code: "invalid_row", message: "该行无法在当前团队范围内匹配，请核对身份或联系管理员", existingId: null });
        continue;
      }
    }
    const orderId = typeof order === "object" && "id" in order ? order.id : orderKeyValue;
    const paymentCents = order.paidAmountCents;
    const currentRefunds = state.refunds.filter((item) => item.orderLineId === orderId && item.status === "succeeded" && item.amountCents !== null && item.refundedAt !== null && Date.parse(item.refundedAt) <= Date.parse(row.refundedAt ?? ""))
      .reduce((sum, item) => addCents(sum, item.direction === "refund" ? item.amountCents! : -item.amountCents!), 0);
    const pendingInBatch = candidateRefundTotals.get(orderKeyValue) ?? 0;
    if (row.status === "succeeded" && row.amountCents !== null) {
      const signed = row.direction === "refund" ? row.amountCents : -row.amountCents;
      const nextTotal = currentRefunds + pendingInBatch + signed;
      if (row.direction === "reversal" && nextTotal < 0) {
        addIssue(issues, rowIssues, { rowNumber: row.rowNumber, entity: "refund", key, code: "refund_reversal_exceeds_refund", message: "退款冲正超过此前已确认的退款金额", existingId: typeof order === "object" && "id" in order ? order.id : null });
        continue;
      }
      if (!Number.isSafeInteger(nextTotal) || (paymentCents !== null && nextTotal > paymentCents)) {
        addIssue(issues, rowIssues, { rowNumber: row.rowNumber, entity: "refund", key, code: "refund_exceeds_payment", message: "累计成功退款将超过该订单行实付金额", existingId: typeof order === "object" && "id" in order ? order.id : null });
        continue;
      }
      candidateRefundTotals.set(orderKeyValue, pendingInBatch + signed);
    }
  }

  // New order rows in this batch must map refunds by the same stable row key and shop.
  // Keep creates/duplicates disjoint from errors so the preview is deterministic.
  const creatorCreates = command.creators.filter((row) => !duplicateCreators.has(row.rowNumber) && !rowIssues.has(`creator:${row.rowNumber}`));
  const orderCreates = command.orders.filter((row) => !duplicateOrders.has(row.rowNumber) && !rowIssues.has(`order:${row.rowNumber}`));
  const refundCreates = command.refunds.filter((row) => !duplicateRefunds.has(row.rowNumber) && !rowIssues.has(`refund:${row.rowNumber}`));
  const kind: ImportBatch["kind"] = command.creators.length && (command.orders.length || command.refunds.length) ? "mixed" : command.creators.length ? "creators" : "orders_and_refunds";
  const result: ImportPreviewResult = {
    batchId: command.batchId, kind, payloadFingerprint: importFingerprint(command),
    totals: { creators: command.creators.length, orders: command.orders.length, refunds: command.refunds.length },
    creates: { creators: creatorCreates.length, orders: orderCreates.length, refunds: refundCreates.length },
    duplicates: { creators: duplicateCreators.size, orders: duplicateOrders.size, refunds: duplicateRefunds.size },
    conflicts: issues.filter((issue) => ["conflicting_replay", "creator_identity_conflict", "duplicate_in_batch"].includes(issue.code)).length,
    errors: issues.length,
    issues,
  };
  return { result, creatorRows: command.creators, orderRows: command.orders, refundRows: command.refunds };
}

function authorizeImport(role: Role, capabilities: Capability[]): void {
  if (role !== "manager" && role !== "admin") domainError("FORBIDDEN", "只有主管或管理员可以导入业务数据");
  if (!capabilities.includes("import.manage")) domainError("FORBIDDEN", "当前账号未获得导入权限");
}

function resultFromBatch(batch: ImportBatch, command: ImportCommand): ImportPreviewResult {
  return {
    batchId: batch.id, kind: batch.kind, payloadFingerprint: batch.payloadFingerprint,
    totals: { creators: command.creators.length, orders: command.orders.length, refunds: command.refunds.length },
    creates: { creators: batch.acceptedCreators, orders: batch.acceptedOrders, refunds: batch.acceptedRefunds },
    duplicates: { creators: batch.duplicateCreators, orders: batch.duplicateOrders, refunds: batch.duplicateRefunds },
    conflicts: batch.issues.filter((issue) => ["conflicting_replay", "creator_identity_conflict", "duplicate_in_batch"].includes(issue.code)).length,
    errors: batch.issues.length,
    issues: batch.issues,
  };
}

function addIssue(issues: ImportIssue[], rowIssues: Set<string>, issue: ImportIssue): void {
  issues.push(issue);
  rowIssues.add(`${issue.entity}:${issue.rowNumber}`);
}

function stripRowNumber<T extends { rowNumber: number }>(row: T): Omit<T, "rowNumber"> {
  const { rowNumber: _rowNumber, ...data } = row;
  return data;
}

function orderFingerprint(row: ImportOrderRow): string {
  return fingerprint(stripRowNumber(fingerprintPlatformRow(row)));
}

function refundFingerprint(row: ImportRefundRow): string {
  return fingerprint(stripRowNumber(fingerprintPlatformRow(row)));
}

function inheritIssue(issues: ImportIssue[], rowIssues: Set<string>, prior: ImportIssue, rowNumber: number): void {
  addIssue(issues, rowIssues, { ...prior, rowNumber, existingId: null });
}

function importPlatform(row: { platform?: Platform }): Platform {
  return row.platform ?? "douyin";
}

function fingerprintPlatformRow<T extends { platform?: Platform }>(row: T): T | Omit<T, "platform"> {
  const platform = importPlatform(row);
  if (platform !== "douyin") return { ...row, platform };
  const { platform: _platform, ...legacyCompatible } = row;
  return legacyCompatible;
}

function accountKey(platform: Platform, externalAccountId: string): string {
  return `${platform}:${normalizeKey(externalAccountId)}`;
}

function orderKey(platform: Platform, shopId: string | null, orderId: string, lineId: string): string {
  return `${platform}:${shopId ?? ""}:${normalizeKey(orderId)}:${normalizeKey(lineId)}`;
}

function refundKey(platform: Platform, shopId: string | null, refundId: string): string {
  return `${platform}:${shopId ?? ""}:${normalizeKey(refundId)}`;
}

function findCreatorAccount(state: DomainState, platform: Platform, externalAccountId: string) {
  return state.creators.find((creator) => creator.accounts.some((account) => account.platform === platform && normalizeKey(account.externalAccountId) === normalizeKey(externalAccountId))) ?? null;
}

function creatorImportMatches(creator: DomainState["creators"][number], row: ImportCreatorRow): boolean {
  const account = creator.accounts.find((item) => item.platform === row.platform && normalizeKey(item.externalAccountId) === normalizeKey(row.externalAccountId));
  if (!account) return false;
  return creator.name === row.name && account.displayName === row.displayName && account.profileUrl === row.profileUrl
    && creator.category === row.category && stableStringify(creator.tags) === stableStringify(row.tags)
    && stableStringify(creator.contact) === stableStringify(row.contact);
}

function resolveImportedCreator(state: DomainState, newlyCreated: Map<string, string>, platform: Platform, creatorAccountId: string | null): string | null {
  if (!creatorAccountId) return null;
  const existing = findCreatorAccount(state, platform, creatorAccountId);
  if (existing) return existing.id;
  return newlyCreated.get(accountKey(platform, creatorAccountId)) ?? null;
}

function resolveImportedProductId(state: DomainState, member: Member, teamId: string, row: ImportOrderRow): string | null {
  if (row.productId) {
    return state.products.some((product) => product.id === row.productId && product.orgId === member.orgId) ? row.productId : null;
  }
  if (!row.sku) return null;
  const matches = state.products.filter((product) => product.orgId === member.orgId && product.teamId === teamId && product.sku === row.sku);
  return matches.length === 1 ? matches[0].id : null;
}

function ownerAt(state: DomainState, creatorId: string, paidAt: string): { memberId: string; validFrom: string } | "ambiguous" | null {
  const at = Date.parse(paidAt);
  const family = creatorIdsInMergeFamily(state, creatorId);
  const matches = state.ownerAssignments.filter((item) => family.has(item.creatorId) && Date.parse(item.validFrom) <= at && (item.validTo === null || at < Date.parse(item.validTo)));
  const owners = new Set(matches.map((item) => item.memberId));
  if (owners.size > 1) return "ambiguous";
  const assignment = matches.sort((a, b) => Date.parse(a.validFrom) - Date.parse(b.validFrom))[0];
  return assignment?.memberId ? { memberId: assignment.memberId, validFrom: assignment.validFrom } : null;
}
