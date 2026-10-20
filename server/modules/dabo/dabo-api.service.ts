import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from '../../http/contracts.ts';
import { z } from 'zod';
import { PLATFORMS, type Actor, type DomainCommandResult, type ImportPreviewResult, type WorkspaceFilters, type WorkspaceSnapshot } from '../../../shared/types.ts';
import type { CsvImportRequest, CsvPreviewResponse, ExportKind } from '../../../shared/http.ts';
import { filterOrdersForView, filterRefundsForView } from '../../../shared/order-view.ts';
import { DomainService, type DomainStore, parseWorkspaceFilters } from '../../domain/domain-service.ts';
import { DomainError } from '../../domain/errors.ts';
import { stableStringify } from '../../domain/utils.ts';
import { IdentityProvider } from './identity.ts';
import { csvCommitSchema, csvRequestSchema, csvTemplate, encodeCsv, prepareCsv } from './csv.ts';

// Production and local demo have mutually exclusive application roots.
// eslint-disable-next-line @darraghor/nestjs-typed/injectable-should-be-provided
export class DaboApiService {
  readonly domain: DomainService;
  // A production key is shared across replicas. No business data are stored in the token.
  private readonly previewKey: Buffer;

  constructor(
    private readonly store: DomainStore,
    readonly identity: IdentityProvider,
    importPreviewSecret?: string,
  ) {
    const configured = identity.mode === 'demo' ? importPreviewSecret : importPreviewSecret ?? process.env.DABO_IMPORT_PREVIEW_SECRET;
    if (identity.mode === 'production' && (!configured || configured.length < 32)) {
      throw new Error('生产环境须配置不少于 32 字符的独立 DABO_IMPORT_PREVIEW_SECRET。');
    }
    this.previewKey = configured ? Buffer.from(configured) : randomBytes(32);
    this.domain = new DomainService(store, {
      businessProgressOwnerSecret: createHmac('sha256', this.previewKey)
        .update('business-progress-owner-v1', 'utf8').digest('hex'),
    });
  }

  session(request: Request, response: Response) { return this.identity.session(request, response, this.domain); }

  async selectDemo(request: Request, response: Response, input: unknown) {
    const parsed = z.object({ principalId: z.string().min(1).max(200) }).strict().parse(input);
    return this.identity.selectDemo(request, response, this.domain, parsed.principalId);
  }

  workspace(request: Request, query: Record<string, unknown>) {
    return this.domain.getWorkspace(this.identity.actor(request), this.filters(query));
  }

  command(request: Request, input: unknown): Promise<DomainCommandResult> {
    this.identity.assertWrite(request);
    // Imports require a reviewed preview at the dedicated endpoint.
    if (typeof input === 'object' && input !== null && 'type' in input) {
      if (String(input.type).startsWith('import.')) throw new DomainError('VALIDATION_ERROR', '请通过导入预览和确认流程提交数据。');
      if (input.type === 'export.record') throw new DomainError('VALIDATION_ERROR', '请通过受控导出入口下载数据。');
    }
    return this.domain.execute(this.identity.actor(request), input);
  }

  template(request: Request, kind: string): string {
    this.identity.actor(request);
    return csvTemplate(z.enum(['creators', 'orders', 'refunds']).parse(kind));
  }

  async preview(request: Request, input: unknown): Promise<CsvPreviewResponse> {
    this.identity.assertWrite(request);
    const actor = this.identity.actor(request);
    const parsed = csvRequestSchema.parse(input);
    const prepared = this.prepare(parsed);
    const previewCommand = { ...prepared.command, batchId: this.batchId(actor, prepared.digest) };
    // Authorize even an invalid-row preview; private CSV cannot be probed by unprivileged users.
    const state = await this.store.read();
    const snapshotDomain = new DomainService({
      read: async () => structuredClone(state),
      transaction: async () => { throw new Error('预览不允许写入。'); },
    });
    const outcome = await snapshotDomain.execute(actor, previewCommand);
    const result = this.previewResult(outcome.result);
    const snapshotDigest = this.stateDigest(state);
    const token = this.signPreview(actor, parsed, snapshotDigest);
    return {
      kind: parsed.kind, sourceName: prepared.sourceName, totalRows: prepared.rows.length,
      headers: prepared.headers, rows: prepared.rows.slice(0, 100),
      previewHash: token, result, validationErrors: prepared.errors,
    };
  }

  async commit(request: Request, input: unknown): Promise<DomainCommandResult> {
    this.identity.assertWrite(request);
    const actor = this.identity.actor(request);
    const { previewHash, ...parsed } = csvCommitSchema.parse(input);
    const prepared = this.prepare(parsed);
    if (prepared.errors.length > 0) throw new DomainError('VALIDATION_ERROR', 'CSV 仍有格式错误，请修正后重新预览。', prepared.errors);
    const state = await this.store.read();
    const expected = this.stateDigest(state);
    this.verifyPreview(previewHash, actor, parsed, expected);
    const command = { ...prepared.command, type: 'import.commit', batchId: this.batchId(actor, prepared.digest) };
    // Domain commit revalidates identifiers, current scope, duplicates and amounts within its transaction.
    const guardedDomain = new DomainService({
      read: () => this.store.read(),
      transaction: (operation) => this.store.transaction((draft) => {
        if (this.stateDigest(draft) !== expected) throw new DomainError('VERSION_CONFLICT', '数据已被其他成员更新，请重新预览。');
        return operation(draft);
      }),
    });
    return guardedDomain.execute(actor, command);
  }

  async export(request: Request, kindInput: string, query: Record<string, unknown>): Promise<string> {
    this.identity.assertWrite(request);
    const actor = this.identity.actor(request);
    const kind = z.enum(['creators', 'samples', 'cooperations', 'schedules', 'deliveries', 'orders', 'refunds', 'tasks']).parse(kindInput);
    const filters = this.exportFilters(query);
    const { platform: _platform, creatorId: _creatorId, search, dateFrom, dateTo, ownerMemberId, teamId, ...workspaceFilters } = filters;
    let snapshot: WorkspaceSnapshot;
    if (kind === 'orders' || kind === 'refunds') {
      // Keep owner checks server-authorized while retaining creator/product context for corrected historical owners.
      if (ownerMemberId) await this.domain.getWorkspace(actor, { ...(teamId ? { teamId } : {}), ownerMemberId, includeClosed: true });
      snapshot = await this.domain.getWorkspace(actor, { ...(teamId ? { teamId } : {}), includeClosed: true });
    } else {
      snapshot = await this.domain.getWorkspace(actor, {
        ...workspaceFilters,
        ...(dateFrom ? { dateFrom } : {}),
        ...(dateTo ? { dateTo } : {}),
        ...(teamId ? { teamId } : {}),
        ...(ownerMemberId ? { ownerMemberId } : {}),
        search,
      });
    }
    const filteredSnapshot = kind === 'orders' || kind === 'refunds'
      ? filterOrderViewSnapshot(snapshot, kind, filters)
      : snapshot;
    const { includeClosed: _closed, ...auditFilters } = filters;
    await this.domain.execute(actor, { type: 'export.record', dataset: kind, filters: auditFilters });
    return exportSnapshot(filteredSnapshot, kind);
  }

  private filters(query: Record<string, unknown>): WorkspaceFilters {
    const input = { ...query };
    if ('includeClosed' in input) {
      if (input.includeClosed !== 'true' && input.includeClosed !== 'false' && typeof input.includeClosed !== 'boolean') throw new DomainError('VALIDATION_ERROR', 'includeClosed 必须是 true 或 false。');
      input.includeClosed = input.includeClosed === 'true' || input.includeClosed === true;
    }
    return parseWorkspaceFilters(input);
  }

  private exportFilters(query: Record<string, unknown>): WorkspaceFilters {
    const input = { ...query };
    const exportSelectors = z.object({
      platform: z.enum([...PLATFORMS, 'all']).optional(),
      creatorId: z.string().trim().min(1).max(160).optional(),
    }).strict().parse({ platform: input.platform, creatorId: input.creatorId });
    delete input.platform;
    delete input.creatorId;
    return { ...this.filters(input), ...exportSelectors };
  }

  private prepare(input: CsvImportRequest) {
    try { return prepareCsv(input); }
    catch (error) { throw new DomainError('VALIDATION_ERROR', error instanceof Error ? error.message : 'CSV 无法解析。'); }
  }

  private batchId(actor: Actor, digest: string): string {
    return `csv-${createHash('sha256').update(`${actor.principalId}:${digest}`).digest('hex').slice(0, 40)}`;
  }

  private previewResult(value: unknown): ImportPreviewResult {
    const counter = z.object({ creators: z.number().int(), orders: z.number().int(), refunds: z.number().int() });
    const schema = z.object({
      batchId: z.string(), kind: z.enum(['creators', 'orders_and_refunds', 'mixed']), payloadFingerprint: z.string(),
      totals: counter, creates: counter, duplicates: counter, conflicts: z.number(), errors: z.number(),
      issues: z.array(z.object({ rowNumber: z.number(), entity: z.enum(['creator', 'order', 'refund']), key: z.string().nullable(), code: z.enum(['invalid_row', 'missing_identity', 'missing_date', 'conflicting_replay', 'order_not_found', 'refund_exceeds_payment', 'refund_reversal_exceeds_refund', 'duplicate_in_batch', 'creator_identity_conflict']), message: z.string(), existingId: z.string().nullable() })),
    });
    return schema.parse(value);
  }

  private stateDigest(state: unknown): string { return createHash('sha256').update(stableStringify(state)).digest('hex'); }
  private inputDigest(input: CsvImportRequest): string { return createHash('sha256').update(stableStringify(input)).digest('hex'); }

  private signPreview(actor: Actor, input: CsvImportRequest, state: string): string {
    const expires = String(Date.now() + 10 * 60 * 1000);
    const digest = createHmac('sha256', this.previewKey).update(`${expires}|${actor.principalId}|${this.inputDigest(input)}|${state}`).digest('hex');
    return `${expires}.${digest}`;
  }

  private verifyPreview(token: string, actor: Actor, input: CsvImportRequest, state: string): void {
    const [expires, signature, extra] = token.split('.');
    const expected = createHmac('sha256', this.previewKey).update(`${expires}|${actor.principalId}|${this.inputDigest(input)}|${state}`).digest('hex');
    if (extra || !/^\d{13}$/u.test(expires ?? '') || Number(expires) < Date.now() || signature?.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      throw new DomainError('VERSION_CONFLICT', '数据或导入内容已变化，或预览已过期，请重新预览。');
    }
  }
}

function filterOrderViewSnapshot(snapshot: WorkspaceSnapshot, kind: 'orders' | 'refunds', filters: WorkspaceFilters): WorkspaceSnapshot {
  const orderViewFilters = {
    dateFrom: filters.dateFrom ?? '',
    dateTo: filters.dateTo ?? '',
    platform: filters.platform ?? 'all',
    teamId: filters.teamId,
    ownerMemberId: filters.ownerMemberId,
    creatorId: filters.creatorId,
    search: filters.search,
  };
  const context = { creators: snapshot.creators, products: snapshot.products, ownerCorrections: snapshot.ownerCorrections };
  if (kind === 'orders') {
    return {
      ...snapshot,
      orders: filterOrdersForView(snapshot.orders, orderViewFilters, context)
        .sort((left, right) => compareViewTimestamps(left.paidAt, right.paidAt)),
    };
  }
  return {
    ...snapshot,
    refunds: filterRefundsForView(snapshot.refunds, snapshot.orders, orderViewFilters, context)
      .sort((left, right) => compareViewTimestamps(left.refundedAt, right.refundedAt)),
  };
}

function compareViewTimestamps(left: string | null, right: string | null) {
  const leftTime = left ? Date.parse(left) : Number.NaN;
  const rightTime = right ? Date.parse(right) : Number.NaN;
  const leftValid = Number.isFinite(leftTime);
  const rightValid = Number.isFinite(rightTime);
  if (!leftValid) return rightValid ? 1 : 0;
  if (!rightValid) return -1;
  return rightTime - leftTime;
}

/** Derive a stable, purpose-separated key from the existing workbook store token. */
export function deriveImportPreviewSecret(storeToken: string): string {
  if (!/^[a-f0-9]{64}$/u.test(storeToken)) throw new Error('DABO_WORKBOOK_STORE_TOKEN must be a 32-byte lowercase hex value');
  return createHmac('sha256', Buffer.from(storeToken, 'hex')).update('dabo-import-preview-v1').digest('hex');
}

function money(cents: number | null): string { return cents === null ? '' : (cents / 100).toFixed(2); }

export function exportSnapshot(snapshot: WorkspaceSnapshot, kind: ExportKind): string {
  const names = new Map(snapshot.creators.map((creator) => [creator.id, creator.name]));
  const members = new Map(snapshot.members.map((member) => [member.id, member.displayName]));
  const mode = snapshot.dataMode === 'demo' ? '合成演示数据' : '业务记录';
  if (kind === 'creators') return encodeCsv(['数据模式', '达人ID', '名称', '平台', '平台账号ID', '类目', '标签', '建联阶段', '负责人'], snapshot.creators.map((row) => [mode, row.id, row.name, row.accounts.map((account) => account.platform).join(';'), row.accounts.map((account) => account.externalAccountId).join(';'), row.category, row.tags.join(';'), row.crmStage, row.ownerMemberId ? members.get(row.ownerMemberId) ?? row.ownerMemberId : '公海']));
  if (kind === 'orders') return encodeCsv(['数据模式', '平台', '订单号', '明细ID', '达人', '支付时间', '状态', '支付金额（元）', '原始归属', '来源批次'], snapshot.orders.map((row) => [mode, row.platform, row.externalOrderId, row.externalLineId, row.creatorId ? names.get(row.creatorId) ?? row.creatorId : '待匹配', row.paidAt, row.status, money(row.paidAmountCents), row.ownerSnapshot.memberId ? members.get(row.ownerSnapshot.memberId) ?? row.ownerSnapshot.memberId : '未归属', row.importBatchId]));
  if (kind === 'refunds') return encodeCsv(['数据模式', '平台', '退款ID', '关联明细ID', '成功时间', '状态', '方向', '金额（元）', '来源批次'], snapshot.refunds.map((row) => [mode, row.platform, row.externalRefundId, row.orderLineId, row.refundedAt, row.status, row.direction, money(row.amountCents), row.importBatchId]));
  if (kind === 'samples') return encodeCsv(['数据模式', '申请ID', '达人', '状态', '商品数量', '申请时间'], snapshot.samples.map((row) => [mode, row.id, names.get(row.creatorId) ?? row.creatorId, row.status, row.lines.reduce((sum, line) => sum + line.quantity, 0), row.createdAt]));
  if (kind === 'cooperations') return encodeCsv(['数据模式', '合作ID', '主题', '达人', '负责人', '状态', '商品数', '截止时间'], snapshot.cooperations.map((row) => [mode, row.id, row.title, names.get(row.creatorId) ?? row.creatorId, members.get(row.ownerMemberId) ?? row.ownerMemberId, row.status, row.lines.length, row.endAt]));
  if (kind === 'schedules') return encodeCsv(['数据模式', '排期ID', '场次', '达人', '计划开始', '计划结束', '状态', '实际结束'], snapshot.schedules.map((row) => [mode, row.id, row.title, names.get(row.creatorId) ?? row.creatorId, row.plannedStartAt, row.plannedEndAt, row.status, row.actualEndAt]));
  if (kind === 'deliveries') return encodeCsv(['数据模式', '交付ID', '名称', '合作ID', '类型', '截止时间', '状态'], snapshot.deliveries.map((row) => [mode, row.id, row.title, row.cooperationId, row.type, row.dueAt, row.status]));
  return encodeCsv(['数据模式', '任务ID', '任务', '类型', '负责人', '截止时间', '状态'], snapshot.tasks.map((row) => [mode, row.id, row.title, row.kind, row.ownerMemberId ? members.get(row.ownerMemberId) ?? row.ownerMemberId : '待分配', row.dueAt, row.status]));
}
