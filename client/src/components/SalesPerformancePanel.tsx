import { useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Check, CircleAlert, ClipboardCheck, ExternalLink, FileText, Pencil, Plus, RotateCcw } from 'lucide-react';
import type { CreatorAccount, CreatorCommerceType, Role, SalesPerformanceWorkspaceItem, WorkspaceSnapshot } from '@shared/types';
import { useWorkbench } from '../workbench-context';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { EmptyState, FormField, formatDate, formatDateTime, formatMoney, Modal, StatusPill, shanghaiDateKey, shanghaiDateTimeInput, shanghaiInputToIso } from './workbench';
import { platformLabel } from '../lib/platform-presentation';
import { parseYuanToCents, shortVideoPeriodBounds, summarizeSalesPerformance, type SalesPerformanceFilters, type SalesReportStatusFilter } from '../lib/sales-performance';
import '../sales-performance.css';

interface SalesPerformancePanelProps {
  filters: Omit<SalesPerformanceFilters, 'status'>;
  formOpen: boolean;
  onFormOpenChange: (open: boolean) => void;
  orderSourceAvailable: boolean;
  orderUnknownCount: number;
}

const reportTabs: Array<{ value: SalesReportStatusFilter; label: string }> = [
  { value: 'all', label: '全部填报' },
  { value: 'pending_review', label: '待核对' },
  { value: 'approved', label: '已通过' },
  { value: 'returned', label: '已退回' },
  { value: 'reconciliation_required', label: '待对账' },
  { value: 'replaced_by_orders', label: '订单已覆盖' },
];

function matchesStatus(report: SalesPerformanceWorkspaceItem, status: SalesReportStatusFilter) {
  if (status === 'all') return true;
  if (status === 'pending_review') return report.status === 'pending_review';
  if (status === 'approved') return report.status === 'approved';
  if (status === 'returned') return report.status === 'returned';
  return report.accountingStatus === status;
}

function accountingLabel(report: SalesPerformanceWorkspaceItem) {
  if (report.accountingStatus === 'counted') return '已计入手工贡献';
  if (report.accountingStatus === 'reconciliation_required') return '待对账 · 暂未计入';
  if (report.accountingStatus === 'replaced_by_orders') return '已由订单覆盖';
  if (report.status === 'returned' || report.accountingStatus === 'returned') return '退回修改';
  return '待负责人核对';
}

function accountingTone(report: SalesPerformanceWorkspaceItem): 'neutral' | 'blue' | 'green' | 'orange' | 'red' {
  if (report.accountingStatus === 'counted') return 'green';
  if (report.accountingStatus === 'reconciliation_required') return 'orange';
  if (report.accountingStatus === 'replaced_by_orders') return 'neutral';
  if (report.status === 'returned' || report.accountingStatus === 'returned') return 'red';
  return 'blue';
}

function memberName(workspace: WorkspaceSnapshot, memberId: string) {
  return workspace.members.find((member) => member.id === memberId)?.displayName ?? '成员信息暂不可用';
}

function periodLabel(report: SalesPerformanceWorkspaceItem) {
  if (report.commerceType === 'live') return `${formatDateTime(report.periodStartAt)} – ${formatDateTime(report.periodEndAt)}`;
  const endDay = shanghaiDateKey(new Date(new Date(report.periodEndAt).getTime() - 86_400_000));
  const startDay = shanghaiDateKey(report.periodStartAt);
  return startDay === endDay ? startDay : `${startDay} – ${endDay}`;
}

function isHttpUrl(value: string) {
  if (!value.trim()) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export default function SalesPerformancePanel({ filters, formOpen, onFormOpenChange, orderSourceAvailable, orderUnknownCount }: SalesPerformancePanelProps) {
  const { workspace, session, run, running, refresh } = useWorkbench();
  const actor = session.actor;
  const canReview = actor.role === 'admin' || actor.role === 'manager';
  const summary = useMemo(() => summarizeSalesPerformance({
    workspace,
    actor,
    filters: { ...filters, status: 'all' },
  }), [workspace, actor.memberId, actor.role, filters]);
  const [statusFilter, setStatusFilter] = useState<SalesReportStatusFilter>('all');
  const [editing, setEditing] = useState<SalesPerformanceWorkspaceItem | null>(null);
  const [detail, setDetail] = useState<SalesPerformanceWorkspaceItem | null>(null);
  const [review, setReview] = useState<{ report: SalesPerformanceWorkspaceItem; decision: 'approved' | 'returned' } | null>(null);
  const [reconcileReport, setReconcileReport] = useState<SalesPerformanceWorkspaceItem | null>(null);
  const [reviewReason, setReviewReason] = useState('');
  const [reconcileReason, setReconcileReason] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const visibleReports = summary.reports.filter((report) => matchesStatus(report, statusFilter));
  const reportCounts = useMemo(() => {
    const counts: Record<SalesReportStatusFilter, number> = { all: summary.reports.length, pending_review: 0, approved: 0, returned: 0, reconciliation_required: 0, replaced_by_orders: 0 };
    for (const report of summary.reports) {
      if (report.status === 'pending_review') counts.pending_review += 1;
      if (report.status === 'approved') counts.approved += 1;
      if (report.status === 'returned') counts.returned += 1;
      if (report.accountingStatus === 'reconciliation_required') counts.reconciliation_required += 1;
      if (report.accountingStatus === 'replaced_by_orders') counts.replaced_by_orders += 1;
    }
    return counts;
  }, [summary.reports]);
  const storeNames = useMemo(() => new Map(workspace.manualStores.map((store) => [store.id, store.name])), [workspace.manualStores]);
  const creatorById = useMemo(() => new Map(workspace.creators.map((creator) => [creator.id, creator])), [workspace.creators]);

  async function submitReview() {
    if (!review || actionBusy) return;
    const reason = reviewReason.trim();
    if (review.decision === 'returned' && !reason) {
      setActionError('退回修改时请填写原因。');
      return;
    }
    setActionBusy(true);
    setActionError('');
    try {
      await run({ type: 'salesReport.review', reportId: review.report.id, expectedVersion: review.report.version, decision: review.decision, reason });
      await refresh();
      toast.success(review.decision === 'approved' ? '业绩填报已通过' : '业绩填报已退回');
      setReview(null);
      setReviewReason('');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '核对失败，请重试。');
    } finally {
      setActionBusy(false);
    }
  }

  async function submitReconciliation() {
    if (!reconcileReport || actionBusy) return;
    const reason = reconcileReason.trim();
    if (!reason) {
      setActionError('请说明订单完整覆盖的依据。');
      return;
    }
    setActionBusy(true);
    setActionError('');
    try {
      await run({ type: 'salesReport.reconcile', reportId: reconcileReport.id, expectedVersion: reconcileReport.version, reason });
      await refresh();
      toast.success('订单覆盖情况已确认');
      setReconcileReport(null);
      setReconcileReason('');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '确认失败，请重试。');
    } finally {
      setActionBusy(false);
    }
  }

  function canEdit(report: SalesPerformanceWorkspaceItem) {
    return report.ownerMemberId === actor.memberId && (report.status === 'pending_review' || report.status === 'returned') && report.accountingStatus !== 'replaced_by_orders';
  }

  function canReviewReport(report: SalesPerformanceWorkspaceItem) {
    return canReview && report.ownerMemberId !== actor.memberId && report.accountingStatus !== 'replaced_by_orders' && (report.status === 'pending_review' || report.status === 'approved');
  }

  function canReconcileReport(report: SalesPerformanceWorkspaceItem) {
    return canReview && report.ownerMemberId !== actor.memberId && report.accountingStatus === 'reconciliation_required';
  }

  function openReview(report: SalesPerformanceWorkspaceItem, decision: 'approved' | 'returned') {
    setActionError('');
    setReviewReason('');
    setReview({ report, decision });
  }

  function openReconciliation(report: SalesPerformanceWorkspaceItem) {
    setActionError('');
    setReconcileReason('');
    setReconcileReport(report);
  }

  function actions(report: SalesPerformanceWorkspaceItem) {
    const replaced = report.accountingStatus === 'replaced_by_orders';
    return <div className="sales-report-actions">
      <Button type="button" variant="outline" size="sm" onClick={() => setDetail(report)}>详情</Button>
      {canEdit(report) && <Button type="button" variant="outline" size="sm" onClick={() => { setEditing(report); onFormOpenChange(true); }}><Pencil size={14} />修改</Button>}
      {canReviewReport(report) && report.status === 'pending_review' && <Button type="button" size="sm" onClick={() => openReview(report, 'approved')}><Check size={14} />通过</Button>}
      {canReviewReport(report) && <Button type="button" variant="outline" size="sm" onClick={() => openReview(report, 'returned')}><RotateCcw size={14} />{report.status === 'approved' ? '退回更正' : '退回'}</Button>}
      {canReconcileReport(report) && <Button type="button" variant="outline" size="sm" onClick={() => openReconciliation(report)}><ClipboardCheck size={14} />核对订单</Button>}
      {replaced && <span className="sales-report-readonly-note">只读</span>}
    </div>;
  }

  const reconciliationNote = summary.reconciliationRequiredCount > 0
    ? `待对账 ${summary.reconciliationRequiredCount} 条，暂停计入 ${formatMoney(summary.reconciliationRequiredCents)}。`
    : '';
  const unknownOverlapNote = summary.hasUnquantifiedOverlap
    ? '部分报告存在可能重叠的订单，请负责人核对。'
    : summary.overlappingOrderCount !== null && summary.overlappingOrderCount > 0 ? `可能重叠订单 ${summary.overlappingOrderCount} 条。` : '';
  const reportDataIncomplete = summary.pendingReviewCount > 0 || summary.returnedCount > 0 || summary.reconciliationRequiredCount > 0 || !orderSourceAvailable || orderUnknownCount > 0;

  return <section className="sales-performance-panel" aria-label="带货业绩填报">
    {(reconciliationNote || unknownOverlapNote || reportDataIncomplete) && <div className="sales-performance-notice" role="status">
      <CircleAlert size={17} aria-hidden="true" />
      <div><strong>{reconciliationNote || (!orderSourceAvailable ? '订单数据尚未完整导入，汇总金额暂不完整。' : '当前汇总仍有待处理记录。')}</strong>
        <span>{[unknownOverlapNote, orderUnknownCount > 0 ? `订单金额待补 ${orderUnknownCount} 条。` : '', summary.pendingReviewCount > 0 ? `待负责人核对 ${summary.pendingReviewCount} 条。` : '', summary.returnedCount > 0 ? `退回待修改 ${summary.returnedCount} 条。` : ''].filter(Boolean).join(' ')}</span>
        {summary.reconciliationRequiredCount > 0 && <span>待对账金额不会计入“计入业绩金额”；待对账合计仍不完整。</span>}
      </div>
    </div>}
    <div className="sales-report-filter-tabs" role="group" aria-label="筛选业绩填报状态">
      {reportTabs.map((tab) => <button key={tab.value} type="button" aria-pressed={statusFilter === tab.value} onClick={() => setStatusFilter(tab.value)}>{tab.label}<span>{reportCounts[tab.value]}</span></button>)}
    </div>
    {visibleReports.length === 0 ? <EmptyState
      icon={<FileText size={20} />}
      title={summary.reports.length === 0 ? '当前筛选范围还没有业绩填报' : '这个状态下暂无填报'}
      description={summary.reports.length === 0 ? '商务可按直播场次或短视频统计周期提交支付成交金额。负责人核对后，手工贡献才会计入。' : '切换状态或调整上方筛选范围。'}
      action={actor.role !== 'ops' && <Button type="button" onClick={() => { setEditing(null); onFormOpenChange(true); }}><Plus size={15} />录入带货业绩</Button>}
    /> : <>
      <div className="sales-report-table-wrap">
        <table className="data-table sales-report-table">
          <thead><tr><th>内容</th><th>达人账号</th><th>店铺</th><th>归属日期</th><th className="numeric">支付成交金额</th><th>核对状态</th><th>填报人</th><th>操作</th></tr></thead>
          <tbody>{visibleReports.map((report) => <tr key={report.id}>
            <td><strong className="sales-report-title">{report.title}</strong><span className="table-secondary">{report.commerceType === 'live' ? '直播场次' : '短视频'} · {report.commerceType === 'short_video' ? `视频 ID ${report.contentId ?? '—'}` : '按直播开始日归属'}</span></td>
            <td><strong>{creatorById.get(report.creatorId)?.name ?? '达人资料暂不可用'}</strong><span className="table-secondary">{creatorById.get(report.creatorId)?.accounts.find((account) => account.id === report.creatorAccountId)?.displayName ?? report.externalAccountId} · {platformLabel(report.platform)}</span></td>
            <td>{storeNames.get(report.storeId) ?? '店铺资料暂不可用'}</td>
            <td>{formatDate(report.creditedOn)}<span className="table-secondary">{periodLabel(report)}</span></td>
            <td className="numeric"><strong>{formatMoney(report.gmvCents)}</strong>{report.orderCount !== null && <span className="table-secondary">{report.orderCount.toLocaleString('zh-CN')} 单</span>}</td>
            <td><StatusPill value={accountingLabel(report)} label={accountingLabel(report)} tone={accountingTone(report)} />{report.accountingStatus === 'reconciliation_required' && <span className="table-secondary">{report.overlappingOrderCount === null ? '可能与订单重复' : `疑似重叠 ${report.overlappingOrderCount} 条`}</span>}</td>
            <td>{memberName(workspace, report.ownerMemberId)}</td>
            <td>{actions(report)}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <div className="sales-report-cards">
        {visibleReports.map((report) => <article className="sales-report-card" key={report.id}>
          <div className="sales-report-card-heading"><div><strong>{report.title}</strong><span>{report.commerceType === 'live' ? '直播场次' : '短视频'} · {platformLabel(report.platform)}</span></div><StatusPill value={accountingLabel(report)} label={accountingLabel(report)} tone={accountingTone(report)} /></div>
          <dl className="sales-report-card-details">
            <div><dt>达人账号</dt><dd>{creatorById.get(report.creatorId)?.name ?? '达人资料暂不可用'} · {creatorById.get(report.creatorId)?.accounts.find((account) => account.id === report.creatorAccountId)?.displayName ?? report.externalAccountId}</dd></div>
            <div><dt>店铺</dt><dd>{storeNames.get(report.storeId) ?? '店铺资料暂不可用'}</dd></div>
            <div><dt>归属日期</dt><dd>{formatDate(report.creditedOn)} · {periodLabel(report)}</dd></div>
            <div><dt>支付成交金额</dt><dd><strong>{formatMoney(report.gmvCents)}</strong>{report.orderCount !== null ? ` · ${report.orderCount.toLocaleString('zh-CN')} 单` : ''}</dd></div>
            <div><dt>填报人</dt><dd>{memberName(workspace, report.ownerMemberId)}</dd></div>
          </dl>
          {report.accountingStatus === 'reconciliation_required' && <p className="sales-report-overlap-note">{report.overlappingOrderCount === null ? '存在可能重叠的订单，请负责人核对。' : `可能与 ${report.overlappingOrderCount} 条导入订单重叠，暂未计入。`}</p>}
          <div className="sales-report-card-actions">{actions(report)}</div>
        </article>)}
      </div>
    </>}
    {summary.memberRows.length > 0 && <div className="sales-member-summary">
      <div className="sales-member-summary-heading"><strong>成员手工贡献</strong><span>仅统计负责人核对且未被订单覆盖的报告；不代表订单支付金额。</span></div>
      <div className="sales-member-summary-list">
        {summary.memberRows.map((member) => {
          const statusNotes = [
            member.pendingReviewCount > 0 ? `待核对 ${member.pendingReviewCount}` : '',
            member.returnedCount > 0 ? `退回 ${member.returnedCount}` : '',
            member.reconciliationRequiredCount > 0 ? `待对账 ${member.reconciliationRequiredCount}（${formatMoney(member.reconciliationRequiredCents)} 暂停计入）` : '',
            member.replacedByOrdersCount > 0 ? `订单已覆盖 ${member.replacedByOrdersCount}` : '',
          ].filter(Boolean);
          return <div className="sales-member-summary-row" key={member.memberId}>
            <div><strong>{member.memberName}</strong><span>{member.teamName}</span></div>
            <div><strong>{formatMoney(member.countedGmvCents)}</strong><span>{member.countedReportCount} 条已计入</span></div>
            {statusNotes.length > 0 && <small>{statusNotes.join(' · ')}</small>}
          </div>;
        })}
      </div>
    </div>}
    {formOpen && <SalesReportForm key={editing?.id ?? 'new'} report={editing ?? undefined} onClose={() => { onFormOpenChange(false); setEditing(null); }} />}
    {detail && <SalesReportDetail report={detail} workspace={workspace} onClose={() => setDetail(null)} />}
    {review && <Modal open onOpenChange={(open) => { if (!open && !actionBusy) setReview(null); }} title={review.decision === 'approved' ? '核对并通过' : review.report.status === 'approved' ? '退回更正' : '退回修改'} description="核对人和处理时间会自动记录到这条填报。" className="modal-standard sales-report-action-modal">
      <div className="sales-action-context"><strong>{review.report.title}</strong><span>{memberName(workspace, review.report.ownerMemberId)} · {formatMoney(review.report.gmvCents)}</span></div>
      <FormField label={review.decision === 'approved' ? '核对说明' : '退回原因'} required={review.decision === 'returned'} hint={review.decision === 'returned' ? '请说明需要补充或修正的内容。' : '可补充本次核对依据。'}><Textarea rows={3} value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} placeholder={review.decision === 'approved' ? '可选' : '填写需要修改的原因'} /></FormField>
      {actionError && <p className="field-error" role="alert">{actionError}</p>}
      <div className="modal-actions"><Button type="button" variant="outline" disabled={actionBusy} onClick={() => setReview(null)}>取消</Button><Button type="button" disabled={actionBusy} onClick={() => void submitReview()}>{actionBusy ? '提交中…' : review.decision === 'approved' ? '确认通过' : '确认退回'}</Button></div>
    </Modal>}
    {reconcileReport && <Modal open onOpenChange={(open) => { if (!open && !actionBusy) setReconcileReport(null); }} title="确认订单完整覆盖" description="确认后，这笔手工金额将由导入订单承接，不再计入手工贡献。" className="modal-standard sales-report-action-modal">
      <div className="sales-action-context"><strong>{reconcileReport.title}</strong><span>{formatMoney(reconcileReport.gmvCents)} 暂停计入 · {reconcileReport.overlappingOrderCount === null ? '存在可能重叠的订单' : `可能重叠 ${reconcileReport.overlappingOrderCount} 条订单`}</span></div>
      <FormField label="对账依据" required hint="请确认导入订单覆盖此报告的完整统计区间和金额。"><Textarea rows={3} required value={reconcileReason} onChange={(event) => setReconcileReason(event.target.value)} placeholder="说明确认订单覆盖的依据" /></FormField>
      {actionError && <p className="field-error" role="alert">{actionError}</p>}
      <div className="modal-actions"><Button type="button" variant="outline" disabled={actionBusy} onClick={() => setReconcileReport(null)}>取消</Button><Button type="button" disabled={actionBusy} onClick={() => void submitReconciliation()}>{actionBusy ? '保存中…' : '确认并替换手工金额'}</Button></div>
    </Modal>}
  </section>;
}

function eligibleCreators(workspace: WorkspaceSnapshot, actor: { memberId: string; role: Role }) {
  const allowedTeams = new Set(workspace.scope.teamIds);
  const activeMembers = new Set(workspace.members.filter((member) => member.active && allowedTeams.has(member.teamId)).map((member) => member.id));
  return workspace.creators.filter((creator) =>
    !creator.archived && !creator.mergedIntoCreatorId && allowedTeams.has(creator.teamId) && creator.ownerMemberId !== null &&
    activeMembers.has(creator.ownerMemberId) && (actor.role !== 'bd' || creator.ownerMemberId === actor.memberId) &&
    creator.accounts.some((account) => account.active),
  );
}

function shortDate(value: string) {
  return shanghaiDateKey(value);
}

function localDateTime(value: string) {
  return shanghaiDateTimeInput(new Date(value));
}

function oneHourBefore(value: string) {
  return shanghaiDateTimeInput(new Date(new Date(`${value}:00+08:00`).getTime() - 3_600_000));
}

function accountLabel(account: CreatorAccount) {
  return `${platformLabel(account.platform)} · ${account.displayName}（${account.externalAccountId}）`;
}

function availableCommerceTypes(account?: CreatorAccount): CreatorCommerceType[] {
  return account?.commerceTypes?.length ? account.commerceTypes : ['live', 'short_video'];
}

function SalesReportForm({ report, onClose }: { report?: SalesPerformanceWorkspaceItem; onClose: () => void }) {
  const { workspace, session, run, running, refresh } = useWorkbench();
  const actor = session.actor;
  const creators = useMemo(() => eligibleCreators(workspace, actor), [workspace, actor.memberId, actor.role]);
  const reportCreator = report ? workspace.creators.find((creator) => creator.id === report.creatorId) : undefined;
  const identityLocked = Boolean(report && actor.role === 'bd' && (!reportCreator || reportCreator.ownerMemberId !== actor.memberId));
  const reportAccount = reportCreator?.accounts.find((item) => item.id === report?.creatorAccountId);
  const reportStore = report ? workspace.manualStores.find((item) => item.id === report.storeId) : undefined;
  const creatorOptions = reportCreator && !creators.some((creator) => creator.id === reportCreator.id) ? [reportCreator, ...creators] : creators;
  const initialCreator = report?.creatorId ?? creatorOptions[0]?.id ?? '';
  const [creatorId, setCreatorId] = useState(initialCreator);
  const creator = creatorOptions.find((item) => item.id === creatorId);
  const activeAccounts = (creator?.accounts ?? []).filter((account) => account.active);
  const initialAccount = activeAccounts.find((account) => account.id === report?.creatorAccountId) ?? activeAccounts[0];
  const [accountId, setAccountId] = useState(report?.creatorAccountId ?? initialAccount?.id ?? '');
  const account = activeAccounts.find((item) => item.id === accountId);
  const commerceTypes = availableCommerceTypes(account);
  const initialType = report?.commerceType && commerceTypes.includes(report.commerceType) ? report.commerceType : commerceTypes[0] ?? 'live';
  const [commerceType, setCommerceType] = useState<CreatorCommerceType>(initialType);
  const storeOptions = workspace.manualStores.filter((store) => store.active && workspace.scope.teamIds.includes(store.teamId) && (!creator || store.teamId === creator.teamId) && (!account || store.platform === account.platform));
  const initialStore = storeOptions.find((store) => store.id === report?.storeId) ?? storeOptions[0];
  const [storeId, setStoreId] = useState(report?.storeId ?? initialStore?.id ?? '');
  const selectedStore = workspace.manualStores.find((store) => store.id === storeId);
  const products = workspace.products.filter((product) => product.active && workspace.scope.teamIds.includes(product.teamId) && (!selectedStore || product.teamId === selectedStore.teamId));
  const assortments = workspace.storeAssortments.filter((assortment) => assortment.active && assortment.storeId === storeId);
  const productsInAssortment = new Set(assortments.map((assortment) => assortment.productId));
  const orderedProducts = [...products].sort((left, right) => Number(productsInAssortment.has(right.id)) - Number(productsInAssortment.has(left.id)) || left.name.localeCompare(right.name, 'zh-CN'));
  const [productIds, setProductIds] = useState<string[]>(report?.productIds.filter((id) => products.some((product) => product.id === id)) ?? []);
  const defaultEnd = shanghaiDateTimeInput();
  const defaultStart = oneHourBefore(defaultEnd);
  const [liveStart, setLiveStart] = useState(report?.commerceType === 'live' ? localDateTime(report.periodStartAt) : defaultStart);
  const [liveEnd, setLiveEnd] = useState(report?.commerceType === 'live' ? localDateTime(report.periodEndAt) : defaultEnd);
  const initialShortStart = report?.commerceType === 'short_video' ? shortDate(report.periodStartAt) : shanghaiDateKey(new Date());
  const initialShortEnd = report?.commerceType === 'short_video' ? shortDate(new Date(new Date(report.periodEndAt).getTime() - 86_400_000).toISOString()) : shanghaiDateKey(new Date());
  const [shortStart, setShortStart] = useState(initialShortStart);
  const [shortEnd, setShortEnd] = useState(initialShortEnd);
  const [title, setTitle] = useState(report?.title ?? '');
  const [contentId, setContentId] = useState(report?.contentId ?? '');
  const [contentUrl, setContentUrl] = useState(report?.contentUrl ?? '');
  const [gmvYuan, setGmvYuan] = useState(report ? (report.gmvCents / 100).toFixed(2) : '');
  const [orderCount, setOrderCount] = useState(report?.orderCount == null ? '' : String(report.orderCount));
  const [evidenceUrl, setEvidenceUrl] = useState(report?.evidenceUrl ?? '');
  const [evidenceNote, setEvidenceNote] = useState(report?.evidenceNote ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const formCommerceType = identityLocked && report ? report.commerceType : commerceType;

  function updateCreator(value: string) {
    const nextCreator = creatorOptions.find((item) => item.id === value);
    const nextAccount = nextCreator?.accounts.find((item) => item.active);
    setCreatorId(value);
    setAccountId(nextAccount?.id ?? '');
    setStoreId(workspace.manualStores.find((store) => store.active && store.teamId === nextCreator?.teamId && store.platform === nextAccount?.platform)?.id ?? '');
    setProductIds([]);
  }

  function updateAccount(value: string) {
    const nextAccount = activeAccounts.find((item) => item.id === value);
    const supported = availableCommerceTypes(nextAccount);
    setAccountId(value);
    if (!supported.includes(commerceType)) setCommerceType(supported[0] ?? 'live');
    const firstStore = workspace.manualStores.find((store) => store.active && store.teamId === selectedStore?.teamId && store.platform === nextAccount?.platform)
      ?? workspace.manualStores.find((store) => store.active && store.teamId === creator?.teamId && store.platform === nextAccount?.platform);
    setStoreId(firstStore?.id ?? '');
    setProductIds([]);
  }

  function toggleProduct(productId: string) {
    setProductIds((current) => current.includes(productId) ? current.filter((id) => id !== productId) : [...current, productId]);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || running) return;
    setError('');
    const amount = parseYuanToCents(gmvYuan);
    const parsedCount = orderCount.trim() ? Number(orderCount) : undefined;
    let periodStartAt = '';
    let periodEndAt = '';
    const effectiveCommerceType = formCommerceType;
    if (!identityLocked && (!creator || !account)) { setError('请选择已归属且启用的平台账号。'); return; }
    if (!identityLocked && (!selectedStore || !selectedStore.active || !account || selectedStore.platform !== account.platform)) { setError('请选择与达人账号同平台的启用店铺。'); return; }
    if (!title.trim()) { setError('请填写场次或视频内容名称。'); return; }
    if (!identityLocked && effectiveCommerceType === 'short_video' && !contentId.trim()) { setError('短视频必须填写平台视频 ID。'); return; }
    if (!identityLocked && productIds.length === 0) { setError('请至少选择一个商品。'); return; }
    if (amount === null) { setError('支付成交金额请填写非负数字，最多保留两位小数。'); return; }
    if (orderCount.trim() && (!Number.isInteger(parsedCount) || (parsedCount ?? -1) < 0)) { setError('订单数请填写非负整数，未知时可留空。'); return; }
    if (!evidenceUrl.trim() && !evidenceNote.trim()) { setError('请提供数据凭证链接或核对依据，至少填写一项。'); return; }
    if (!isHttpUrl(evidenceUrl) || (!identityLocked && !isHttpUrl(contentUrl))) { setError('链接需使用 http 或 https 地址。'); return; }
    if (identityLocked && report) {
      periodStartAt = report.periodStartAt;
      periodEndAt = report.periodEndAt;
    } else if (effectiveCommerceType === 'live') {
      if (!liveStart || !liveEnd || new Date(`${liveEnd}:00+08:00`).getTime() <= new Date(`${liveStart}:00+08:00`).getTime()) {
        setError('请填写有效的直播开始和结束时间，结束时间应晚于开始时间。');
        return;
      }
      periodStartAt = shanghaiInputToIso(liveStart);
      periodEndAt = shanghaiInputToIso(liveEnd);
    } else {
      try {
        const bounds = shortVideoPeriodBounds(shortStart, shortEnd);
        periodStartAt = bounds.periodStartAt;
        periodEndAt = bounds.periodEndAt;
      } catch (validationError) {
        setError(validationError instanceof Error ? validationError.message : '请检查短视频统计周期。');
        return;
      }
    }

    const fields = {
      creatorId: identityLocked && report ? report.creatorId : creator!.id,
      creatorAccountId: identityLocked && report ? report.creatorAccountId : account!.id,
      storeId: identityLocked && report ? report.storeId : selectedStore!.id,
      commerceType: effectiveCommerceType,
      title: title.trim(),
      ...((identityLocked ? report?.contentId : contentId.trim()) ? { contentId: identityLocked ? report!.contentId! : contentId.trim() } : {}),
      ...((identityLocked ? report?.contentUrl : contentUrl.trim()) ? { contentUrl: identityLocked ? report!.contentUrl! : contentUrl.trim() } : {}),
      productIds: identityLocked && report ? report.productIds : productIds,
      periodStartAt,
      periodEndAt,
      gmvCents: amount,
      ...(parsedCount !== undefined ? { orderCount: parsedCount } : {}),
      ...(evidenceUrl.trim() ? { evidenceUrl: evidenceUrl.trim() } : {}),
      ...(evidenceNote.trim() ? { evidenceNote: evidenceNote.trim() } : {}),
    };
    setSaving(true);
    try {
      if (report) await run({ type: 'salesReport.update', reportId: report.id, expectedVersion: report.version, ...fields });
      else await run({ type: 'salesReport.create', ...fields });
      await refresh();
      toast.success(report ? '业绩填报已更新，等待负责人核对' : '业绩已提交，等待负责人核对');
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存失败，请重试。');
    } finally {
      setSaving(false);
    }
  }

  return <Modal open onOpenChange={(open) => { if (!open && !saving) onClose(); }} title={report ? '修改带货业绩' : '录入带货业绩'} description="填写支付成交金额。提交后由负责人核对；退款仍以导入订单明细为准。" className="modal-standard modal-wide sales-report-form-modal">
    <form className="modal-form sales-report-form" onSubmit={(event) => void submit(event)}>
      <div className="sales-report-form-scroll">
      <div className="sales-report-form-intro"><strong>填报人：{actor.displayName}</strong><span>系统自动记录为当前登录人，负责人核对后才计入团队手工贡献。</span></div>
      {report?.status === 'returned' && report.reviewNote?.trim() && <div className="notice notice-warning sales-report-return-note"><CircleAlert size={16} aria-hidden="true" /><span>负责人退回原因：{report.reviewNote}</span></div>}
      {identityLocked && report && <div className="sales-identity-locked" role="status"><strong>达人归属已调整，以下关联信息沿用原填报并锁定。</strong><dl>
        <div><dt>达人账号</dt><dd>{reportCreator?.name ?? '达人资料暂不可用'} · {reportAccount?.displayName ?? report.externalAccountId} · {platformLabel(report.platform)}</dd></div>
        <div><dt>店铺与方式</dt><dd>{reportStore?.name ?? '店铺资料暂不可用'} · {report.commerceType === 'live' ? '直播场次' : '短视频'}</dd></div>
        <div><dt>统计区间</dt><dd>{periodLabel(report)} · 归属 {formatDate(report.creditedOn)}</dd></div>
        <div><dt>关联商品</dt><dd>{report.productIds.map((id) => workspace.products.find((item) => item.id === id)?.name ?? '商品资料暂不可用').join('、')}</dd></div>
        {report.commerceType === 'short_video' && <div><dt>视频 ID</dt><dd>{report.contentId ?? '—'}</dd></div>}
        {report.contentUrl && <div><dt>视频链接</dt><dd>{report.contentUrl}</dd></div>}
      </dl><span>可修改本次填报标题、金额、订单数和数据凭证。</span></div>}
      <div className="sales-report-form-grid">
        {!identityLocked && <>
          <FormField label="达人" required><select className="native-select" value={creatorId} onChange={(event) => updateCreator(event.target.value)} required><option value="">选择已归属达人的账号</option>{creatorOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></FormField>
          <FormField label="平台账号" required><select className="native-select" value={accountId} onChange={(event) => updateAccount(event.target.value)} required disabled={!activeAccounts.length}><option value="">选择启用账号</option>{activeAccounts.map((item) => <option key={item.id} value={item.id}>{accountLabel(item)}</option>)}</select></FormField>
          <FormField label="店铺" required hint="只能选择与平台账号同平台的启用店铺。"><select className="native-select" value={storeId} onChange={(event) => { setStoreId(event.target.value); setProductIds([]); }} required disabled={!storeOptions.length}><option value="">选择店铺</option>{storeOptions.map((store) => <option value={store.id} key={store.id}>{store.name} · {platformLabel(store.platform)}</option>)}</select></FormField>
          <FormField label="带货方式" required><select className="native-select" value={commerceType} onChange={(event) => setCommerceType(event.target.value as CreatorCommerceType)}>{commerceTypes.map((type) => <option key={type} value={type}>{type === 'live' ? '直播按场次' : '短视频按内容与周期'}</option>)}</select></FormField>
        </>}
        <FormField label={formCommerceType === 'live' ? '直播场次名称' : '视频内容名称'} required><Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} required placeholder={formCommerceType === 'live' ? '填写本场直播标题' : '填写视频标题或内容摘要'} /></FormField>
        {!identityLocked && formCommerceType === 'short_video' && <FormField label="平台视频 ID" required hint="使用稳定的视频 ID 识别内容，便于后续和订单归因核对。"><Input value={contentId} onChange={(event) => setContentId(event.target.value)} maxLength={300} required placeholder="填写平台返回的视频 ID" /></FormField>}
        {!identityLocked && formCommerceType === 'short_video' && <FormField label="视频链接"><Input type="url" value={contentUrl} onChange={(event) => setContentUrl(event.target.value)} placeholder="https://…" /></FormField>}
        {!identityLocked && (formCommerceType === 'live' ? <>
          <FormField label="直播开始时间" required><Input type="datetime-local" value={liveStart} onChange={(event) => setLiveStart(event.target.value)} required /></FormField>
          <FormField label="直播结束时间" required><Input type="datetime-local" value={liveEnd} onChange={(event) => setLiveEnd(event.target.value)} required /></FormField>
        </> : <>
          <FormField label="统计开始日期" required><Input type="date" value={shortStart} onChange={(event) => setShortStart(event.target.value)} required /></FormField>
          <FormField label="统计结束日期（含当天）" required hint="系统按次日 00:00 保存为结束边界；跨月请分段填报。"><Input type="date" value={shortEnd} onChange={(event) => setShortEnd(event.target.value)} required /></FormField>
        </>)}
        <FormField label="支付成交金额（元）" required hint="填平台统计的支付成交金额，不扣退款。"><Input type="number" inputMode="decimal" min="0" step="0.01" value={gmvYuan} onChange={(event) => setGmvYuan(event.target.value)} required placeholder="0.00" /></FormField>
        <FormField label="订单数" hint="可留空表示未知；不作为订单明细。"><Input type="number" inputMode="numeric" min="0" step="1" value={orderCount} onChange={(event) => setOrderCount(event.target.value)} placeholder="未知可留空" /></FormField>
      </div>
      {!identityLocked && <fieldset className="sales-product-picker">
        <legend>关联商品 <b aria-hidden="true">*</b></legend>
        {orderedProducts.length > 0 ? <div className="sales-product-options">{orderedProducts.map((product) => <label className="sales-product-option" key={product.id}><input type="checkbox" checked={productIds.includes(product.id)} onChange={() => toggleProduct(product.id)} /><span>{product.brand} · {product.name}{product.sku ? ` · ${product.sku}` : ''}</span>{productsInAssortment.has(product.id) && <small>店铺货盘</small>}</label>)}</div> : <p className="sales-product-empty">当前店铺团队没有可用商品，请先到商品模块启用商品。</p>}
      </fieldset>}
      <div className="sales-report-form-grid">
        <FormField label="数据凭证链接" hint="可填写后台截图或数据页面链接。"><Input type="url" value={evidenceUrl} onChange={(event) => setEvidenceUrl(event.target.value)} placeholder="https://…" /></FormField>
        <FormField label="核对依据" hint="至少提供链接或文字依据之一。"><Textarea rows={2} value={evidenceNote} onChange={(event) => setEvidenceNote(event.target.value)} placeholder="例如：平台结算页的支付成交金额及统计区间" /></FormField>
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
      {!identityLocked && !creatorOptions.length && <p className="notice notice-warning">当前账号没有可用的已归属达人平台账号，请先在达人里补齐负责人和启用账号。</p>}
      {!identityLocked && !storeOptions.length && <p className="notice notice-warning">当前平台没有启用店铺，请先到商品模块录入店铺。</p>}
      </div>
      <div className="modal-actions sales-report-form-actions"><Button type="button" variant="outline" disabled={saving || running} onClick={onClose}>取消</Button><Button type="submit" disabled={saving || running || (!identityLocked && (!creatorOptions.length || !storeOptions.length || !orderedProducts.length))}>{saving || running ? '提交中…' : report ? '保存并重新提交' : '提交核对'}</Button></div>
    </form>
  </Modal>;
}

function SalesReportDetail({ report, workspace, onClose }: { report: SalesPerformanceWorkspaceItem; workspace: WorkspaceSnapshot; onClose: () => void }) {
  const creator = workspace.creators.find((item) => item.id === report.creatorId);
  const account = creator?.accounts.find((item) => item.id === report.creatorAccountId);
  const store = workspace.manualStores.find((item) => item.id === report.storeId);
  const productNames = report.productIds.map((id) => workspace.products.find((item) => item.id === id)?.name ?? '商品资料暂不可用');
  return <Modal open onOpenChange={(open) => { if (!open) onClose(); }} title={report.title} description={`${creator?.name ?? '达人资料暂不可用'} · ${account?.displayName ?? report.externalAccountId} · ${platformLabel(report.platform)}`} className="modal-standard modal-wide sales-report-detail-modal">
    <div className="sales-report-detail-status"><StatusPill value={accountingLabel(report)} label={accountingLabel(report)} tone={accountingTone(report)} /><span>填报人：{memberName(workspace, report.ownerMemberId)}</span><span>提交于 {formatDateTime(report.submittedAt)}</span></div>
    {report.accountingStatus === 'reconciliation_required' && <div className="sales-report-overlap-box"><CircleAlert size={17} /><div><strong>{report.overlappingOrderCount === null ? '存在可能重叠的订单，请负责人核对' : `可能与 ${report.overlappingOrderCount} 条导入订单重叠`}</strong><span>{formatMoney(report.gmvCents)} 暂停计入，待对账合计仍不完整。</span></div></div>}
    <dl className="sales-report-detail-grid">
      <div><dt>带货方式</dt><dd>{report.commerceType === 'live' ? '直播场次' : '短视频'}</dd></div>
      <div><dt>平台店铺</dt><dd>{platformLabel(report.platform)} · {store?.name ?? '店铺资料暂不可用'}</dd></div>
      <div><dt>统计区间</dt><dd>{periodLabel(report)}</dd></div>
      <div><dt>归属日期</dt><dd>{formatDate(report.creditedOn)}{report.commerceType === 'short_video' ? ' · 按统计区间结束日归属' : ' · 按直播开始日归属'}</dd></div>
      <div><dt>支付成交金额</dt><dd>{formatMoney(report.gmvCents)}{report.orderCount !== null ? ` · ${report.orderCount.toLocaleString('zh-CN')} 单` : ' · 订单数未知'}</dd></div>
      <div><dt>关联商品</dt><dd>{productNames.join('、')}</dd></div>
      {report.commerceType === 'short_video' && <div><dt>平台视频 ID</dt><dd>{report.contentId ?? '—'}</dd></div>}
      {report.contentUrl && <div><dt>视频链接</dt><dd><a href={report.contentUrl} target="_blank" rel="noreferrer">打开视频 <ExternalLink size={13} /></a></dd></div>}
      {report.evidenceUrl && <div><dt>数据凭证</dt><dd><a href={report.evidenceUrl} target="_blank" rel="noreferrer">打开凭证 <ExternalLink size={13} /></a></dd></div>}
      {report.evidenceNote && <div className="span-all"><dt>填报依据</dt><dd>{report.evidenceNote}</dd></div>}
      {report.reviewedBy && <div className="span-all"><dt>核对记录</dt><dd>{memberName(workspace, report.reviewedBy)} · {report.reviewNote || (report.status === 'approved' ? '已通过' : '已退回')} · {formatDateTime(report.reviewedAt)}</dd></div>}
      {report.reconciledBy && <div className="span-all"><dt>订单对账记录</dt><dd>{memberName(workspace, report.reconciledBy)} · {report.reconciliationNote || '已确认订单完整覆盖'} · {formatDateTime(report.reconciledAt)}</dd></div>}
    </dl>
    <div className="modal-actions"><Button type="button" variant="outline" onClick={onClose}>关闭</Button></div>
  </Modal>;
}
