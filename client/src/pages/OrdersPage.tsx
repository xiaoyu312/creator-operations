import { useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import '../operations-surfaces.css';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Download, FileUp, RefreshCw, Search, Upload } from 'lucide-react';
import type { ImportIssue, OrderLine, RefundEvent, WorkspaceFilters } from '@shared/types';
import type { CsvPreviewResponse } from '@shared/http';
import { useWorkbench } from '../workbench-context';
import { commitCsvImport, downloadCsvExport, downloadCsvTemplate, previewCsvImport, type ImportKind } from '../api';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Modal, PageHeading, Panel, StatusPill, EmptyState, FormField, formatDateTime, formatMoney, shanghaiDateTimeInput, shanghaiInputToIso } from '../components/workbench';
import { compareTimestamps } from '../lib/time';
import { getBusinessOrderSourceStatus } from '../lib/business-home';
import { filterOrdersForView, filterRefundsForView, resolveOrderOwner } from '@shared/order-view';
import { normalizeOrderViewPlatform, summarizeOrderViewMetrics } from '../lib/order-view';
import { creatorPlatformOptions, platformLabel } from '../lib/platform-presentation';
import { buildShopFilterOptions, decodeShopFilterValue, encodeShopFilterValue, matchesShopFilter } from '../lib/team-performance';

const requiredColumns: Record<ImportKind, string[]> = {
  creators: ['externalAccountId', 'name'],
  orders: ['externalOrderId', 'externalLineId'],
  refunds: ['externalRefundId', 'externalOrderId', 'externalLineId'],
};
const optionalColumns: Record<ImportKind, string[]> = {
  creators: ['platform', 'displayName', 'category', 'tags', 'source', 'profileUrl', 'contactName', 'phone', 'email', 'handle'],
  orders: ['platform', 'shopId', 'creatorAccountId', 'paidAt', 'status', 'paidAmount', 'productId', 'sku'],
  refunds: ['platform', 'shopId', 'refundedAt', 'status', 'amount', 'direction'],
};
const columnLabels: Record<string, string> = {
  platform: '平台', externalAccountId: '平台账号 ID', name: '达人主体名称', displayName: '账号昵称', category: '类目', tags: '标签', source: '来源', profileUrl: '主页链接',
  shopId: '店铺 ID', externalOrderId: '订单号', externalLineId: '订单明细 ID', creatorAccountId: '达人账号 ID', paidAt: '支付时间', status: '订单状态', paidAmount: '支付金额', productId: '商品 ID', sku: 'SKU',
  externalRefundId: '退款 ID', refundedAt: '退款时间', amount: '退款金额', direction: '退款方向',
};
const importKinds: Array<{ value: ImportKind; label: string }> = [{ value: 'creators', label: '达人档案' }, { value: 'orders', label: '订单明细' }, { value: 'refunds', label: '退款事件' }];

export default function OrdersPage() {
  const { workspace, session, refresh } = useWorkbench();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTabState] = useState<'orders' | 'refunds'>(() => searchParams.get('tab') === 'refunds' ? 'refunds' : 'orders');
  const query = searchParams.get('q') ?? '';
  const [importOpen, setImportOpen] = useState(false);
  const [correctingOrder, setCorrectingOrder] = useState<OrderLine | null>(null);
  const [reconcilingOrder, setReconcilingOrder] = useState<OrderLine | null>(null);
  const [reconcilingRefund, setReconcilingRefund] = useState<RefundEvent | null>(null);
  const dateFrom = searchParams.get('dateFrom') ?? '';
  const dateTo = searchParams.get('dateTo') ?? '';
  const platformFilter = normalizeOrderViewPlatform(searchParams.get('platform'));
  const creatorIdFilter = searchParams.get('creatorId');
  const creatorFilter = creatorIdFilter ? workspace.creators.find((creator) => creator.id === creatorIdFilter) ?? null : null;
  const ownerMemberId = searchParams.get('ownerMemberId') ?? 'all';
  const teamId = searchParams.get('teamId') ?? 'all';
  const shopId = searchParams.get('shopId') ?? 'all';
  const shopPlatform = normalizeOrderViewPlatform(searchParams.get('shopPlatform'));
  const canFilterTeam = workspace.scope.teamIds.length > 1;
  const canImport = session.actor.capabilities.includes('import.manage');
  const canExport = session.actor.capabilities.includes('export.run');
  const canCorrectOwner = session.actor.capabilities.includes('import.manage');
  const refundsImported = workspace.metrics.dataCoverage.refundDataStatus === 'records_only';
  const orderSourceStatus = getBusinessOrderSourceStatus({ orders: workspace.orders, importBatches: workspace.importBatches, importHistoryVisible: workspace.metrics.dataCoverage.importHistoryVisible });
  const orderViewFilters = useMemo(() => ({
    dateFrom,
    dateTo,
    platform: platformFilter,
    teamId: teamId === 'all' ? null : teamId,
    ownerMemberId: session.actor.role === 'bd' ? session.actor.memberId : ownerMemberId === 'all' ? null : ownerMemberId,
    creatorId: creatorIdFilter,
    search: query,
  }), [dateFrom, dateTo, platformFilter, teamId, session.actor.role, session.actor.memberId, ownerMemberId, creatorIdFilter, query]);
  const orderViewContext = useMemo(() => ({
    creators: workspace.creators,
    products: workspace.products,
    ownerCorrections: workspace.ownerCorrections,
  }), [workspace.creators, workspace.products, workspace.ownerCorrections]);
  const ordersById = useMemo(() => new Map(workspace.orders.map((order) => [order.id, order])), [workspace.orders]);
  const shopOptions = useMemo(() => {
    const shopTeamIds = teamId === 'all' ? workspace.scope.teamIds : workspace.scope.teamIds.includes(teamId) ? [teamId] : [];
    return buildShopFilterOptions({
      stores: workspace.manualStores,
      orders: workspace.orders,
      allowedTeamIds: shopTeamIds,
      platformFilter,
      selectedShopId: shopId,
      selectedShopPlatform: shopPlatform,
    });
  }, [workspace.orders, workspace.manualStores, workspace.scope.teamIds, teamId, platformFilter, shopId, shopPlatform]);
  const shopSelectValue = shopId === 'all' ? 'all' : encodeShopFilterValue(shopId, shopPlatform);
  const visibleOrders = useMemo(() => filterOrdersForView(workspace.orders, orderViewFilters, orderViewContext)
    .filter((order) => matchesShopFilter(order.shopId, order.platform, shopId, shopPlatform))
    .sort((a, b) => compareTimestamps(a.paidAt, b.paidAt, 'desc')),
  [workspace.orders, orderViewFilters, orderViewContext, shopId, shopPlatform]);
  const visibleRefunds = useMemo(() => filterRefundsForView(workspace.refunds, workspace.orders, orderViewFilters, orderViewContext)
    .filter((refund) => {
      const order = ordersById.get(refund.orderLineId);
      return order ? matchesShopFilter(order.shopId, order.platform, shopId, shopPlatform) : shopId === 'all';
    })
    .sort((a, b) => compareTimestamps(a.refundedAt, b.refundedAt, 'desc')),
  [workspace.refunds, workspace.orders, orderViewFilters, orderViewContext, ordersById, shopId, shopPlatform]);
  const orderMetrics = useMemo(() => summarizeOrderViewMetrics({
    orders: visibleOrders,
    visibleRefunds,
    allRefunds: workspace.refunds,
    orderSourceAvailable: orderSourceStatus === 'records_only',
    refundSourceAvailable: refundsImported,
    observedAt: workspace.metrics.observedAt,
    getOrderOwner: (order) => resolveOrderOwner(order, workspace.ownerCorrections),
  }), [visibleOrders, visibleRefunds, workspace.refunds, workspace.ownerCorrections, orderSourceStatus, refundsImported, workspace.metrics.observedAt]);

  const setFilterParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value && value !== 'all') next.set(key, value); else next.delete(key);
    if (key === 'platform' && shopId !== 'all' && shopPlatform !== 'all' && value !== 'all' && value !== shopPlatform) {
      next.delete('shopId');
      next.delete('shopPlatform');
    }
    setSearchParams(next, { replace: true });
  };
  const setShopFilter = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === 'all') {
      next.delete('shopId');
      next.delete('shopPlatform');
    } else {
      const selection = decodeShopFilterValue(value);
      if (!selection) return;
      next.set('shopId', selection.shopId);
      next.set('shopPlatform', selection.shopPlatform);
    }
    setSearchParams(next, { replace: true });
  };
  const setTab = (nextTab: 'orders' | 'refunds') => {
    setTabState(nextTab);
    const next = new URLSearchParams(searchParams);
    if (nextTab === 'refunds') next.set('tab', 'refunds'); else next.delete('tab');
    setSearchParams(next, { replace: true });
  };
  const clearFilters = () => {
    const next = new URLSearchParams(searchParams);
    for (const key of ['q', 'dateFrom', 'dateTo', 'platform', 'teamId', 'ownerMemberId', 'creatorId', 'shopId', 'shopPlatform']) next.delete(key);
    setSearchParams(next, { replace: true });
  };

  async function exportData(kind: 'creators' | 'orders' | 'refunds') {
    try {
      const filters: WorkspaceFilters = {
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        search: query.trim() || undefined,
        ownerMemberId: session.actor.role === 'bd' ? undefined : ownerMemberId === 'all' ? undefined : ownerMemberId,
        teamId: teamId === 'all' ? undefined : teamId,
        platform: platformFilter === 'all' ? undefined : platformFilter,
        creatorId: creatorIdFilter || undefined,
      };
      const blob = await downloadCsvExport(kind, filters);
      saveBlob(blob, `达播协作台-${kind}-${new Date().toISOString().slice(0, 10)}.csv`);
      toast.success('订单已导出');
    } catch (error) { toast.error(error instanceof Error ? error.message : '导出失败'); }
  }

  const paidAmount = orderMetrics.paidOrders.amount;
  const paidAmountHint = paidAmount === null
    ? '订单信息待补充'
    : paidAmount.unknownCount > 0
      ? `${paidAmount.knownCents ? `已知金额 ${formatMoney(paidAmount.knownCents)} · ` : ''}${paidAmount.unknownCount} 笔金额待补充`
      : `成交金额 ${formatMoney(paidAmount.knownCents)}`;
  const refundAmount = orderMetrics.refunds.amount;
  const refundAmountHint = refundAmount === null
    ? '退款信息待补充'
    : refundAmount.unknownCount > 0
      ? `${refundAmount.knownCents ? `已知金额 ${formatMoney(refundAmount.knownCents)} · ` : ''}${refundAmount.unknownCount} 笔金额待补充`
      : `退款金额 ${formatMoney(refundAmount.knownCents)}`;
  const netAmount = orderMetrics.netPaidCohort.amount;
  const noOrderRows = workspace.orders.length === 0;
  return <div className="page-stack ops-page ops-page--orders">
    <PageHeading title="订单与退款" description={noOrderRows ? '还没有订单数据' : undefined} actions={<>{canImport && <Button variant="outline" onClick={() => setImportOpen(true)}><Upload size={15} />导入数据</Button>}{canExport && !noOrderRows && <Button onClick={() => void exportData(tab === 'orders' ? 'orders' : 'refunds')}><Download size={15} />导出当前列表</Button>}</>} />
    {creatorIdFilter && <div className="notice notice-info">{creatorFilter ? <>达人：{creatorFilter.accounts.find((account) => account.active)?.displayName ?? creatorFilter.name} · <Link to={`/creators?creatorId=${encodeURIComponent(creatorFilter.id)}`}>返回达人档案</Link></> : '暂无可查看订单'}</div>}
    {noOrderRows ? <EmptyState title="还没有订单数据" description={canImport ? '导入平台订单后，这里会显示订单数和成交金额。' : '管理员导入订单后，这里会显示订单和退款。'} action={canImport ? <Button size="sm" onClick={() => setImportOpen(true)}><Upload size={14} />导入订单</Button> : undefined} /> : <div className="page-grid metrics-grid order-metrics"><div className="small-metric"><span>订单数</span><strong>{orderMetrics.paidOrders.count ?? '待补充'}</strong><small>{paidAmountHint}</small></div><div className="small-metric"><span>退款</span><strong>{orderMetrics.refunds.count ?? '待补充'}</strong><small>{refundAmountHint}</small></div><div className="small-metric"><span>退款后金额</span><strong>{netAmount?.complete ? formatMoney(netAmount.knownCents) : '待补充'}</strong><small>{netAmount && !netAmount.complete ? `${netAmount.unknownCount} 笔金额待补充` : netAmount ? '按订单支付时间统计' : '订单或退款信息待补充'}</small></div><div className="small-metric"><span>未归属负责人</span><strong>{orderMetrics.paidOrders.unassignedCount ?? '—'}</strong></div></div>}
    {!noOrderRows && <Panel title="业务明细">
      <div className="tab-row" role="tablist" aria-label="订单或退款明细"><button className="tab-button" role="tab" aria-selected={tab === 'orders'} onClick={() => setTab('orders')}>订单明细<span className="count-badge">{visibleOrders.length}</span></button><button className="tab-button" role="tab" aria-selected={tab === 'refunds'} onClick={() => setTab('refunds')}>退款事件<span className="count-badge">{visibleRefunds.length}</span></button></div>
      <div className="toolbar"><label className="search-field"><Search size={14} /><input value={query} onChange={(event) => setFilterParam('q', event.target.value)} placeholder={tab === 'orders' ? '订单号、商品、SKU 或达人' : '退款号、订单号或明细号'} aria-label="搜索订单和退款" /></label><label className="date-filter-label">支付 / 退款日期<input type="date" value={dateFrom} onChange={(event) => setFilterParam('dateFrom', event.target.value)} aria-label="开始日期" /></label><span>至</span><input className="filter-input" type="date" value={dateTo} onChange={(event) => setFilterParam('dateTo', event.target.value)} aria-label="结束日期" /><select className="filter-select" value={platformFilter} onChange={(event) => setFilterParam('platform', event.target.value)} aria-label="筛选平台">{creatorPlatformOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><select className="filter-select" value={shopSelectValue} onChange={(event) => setShopFilter(event.target.value)} aria-label="筛选店铺"><option value="all">全部店铺</option>{shopOptions.map((option) => <option key={encodeShopFilterValue(option.shopId, option.shopPlatform)} value={encodeShopFilterValue(option.shopId, option.shopPlatform)}>{option.shopPlatform === 'all' ? '全部平台' : platformLabel(option.shopPlatform)} · {option.name}</option>)}</select>{canFilterTeam && <select className="filter-select" value={teamId} onChange={(event) => { const next = new URLSearchParams(searchParams); if (event.target.value === 'all') next.delete('teamId'); else next.set('teamId', event.target.value); next.delete('ownerMemberId'); setSearchParams(next, { replace: true }); }} aria-label="筛选团队"><option value="all">全部团队</option>{workspace.teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select>}{session.actor.role !== 'bd' && <select className="filter-select" value={ownerMemberId} onChange={(event) => setFilterParam('ownerMemberId', event.target.value)} aria-label="筛选负责人"><option value="all">全部负责人</option>{workspace.members.filter((member) => teamId === 'all' || member.teamId === teamId).map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select>}<button className="link-button" onClick={clearFilters}>清除筛选</button></div>
      {tab === 'orders' ? <OrdersTable orders={visibleOrders} canCorrectOwner={canCorrectOwner} canReconcile={canImport} onCorrectOwner={setCorrectingOrder} onReconcile={setReconcilingOrder} refundsImported={refundsImported} canImport={canImport} onImport={() => setImportOpen(true)} /> : <RefundsTable refunds={visibleRefunds} orders={workspace.orders} refundDataStatus={workspace.metrics.dataCoverage.refundDataStatus} canImport={canImport} onImport={() => setImportOpen(true)} canReconcile={canImport} onReconcile={setReconcilingRefund} />}
    </Panel>}
    <CsvImportDialog open={importOpen} onOpenChange={setImportOpen} onCommitted={refresh} />
    {correctingOrder && <OwnerCorrectionDialog order={correctingOrder} open onOpenChange={(open) => { if (!open) setCorrectingOrder(null); }} />}
    {reconcilingOrder && <OrderReconciliationDialog order={reconcilingOrder} open onOpenChange={(open) => { if (!open) setReconcilingOrder(null); }} />}
    {reconcilingRefund && <RefundReconciliationDialog refund={reconcilingRefund} open onOpenChange={(open) => { if (!open) setReconcilingRefund(null); }} />}
  </div>;
}

function OrdersTable({ orders, canCorrectOwner, canReconcile, onCorrectOwner, onReconcile, refundsImported, canImport, onImport }: { orders: OrderLine[]; canCorrectOwner: boolean; canReconcile: boolean; onCorrectOwner: (order: OrderLine) => void; onReconcile: (order: OrderLine) => void; refundsImported: boolean; canImport: boolean; onImport: () => void }) {
  const { workspace } = useWorkbench();
  return orders.length ? <div className="table-wrap"><table className="data-table order-table"><thead><tr><th>订单 / 达人</th><th>商品</th><th>支付时间</th><th>订单状态</th><th className="numeric">成交金额</th><th className="numeric">退款后金额</th><th>负责人</th></tr></thead><tbody>{orders.map((order) => {
    const creator = order.creatorId ? workspace.creators.find((item) => item.id === order.creatorId) : undefined;
    const product = order.productId ? workspace.products.find((item) => item.id === order.productId) : undefined;
    const member = workspace.members.find((item) => item.id === resolveOrderOwner(order, workspace.ownerCorrections));
    const orderRefunds = workspace.refunds.filter((refund) => refund.orderLineId === order.id && refund.status === 'succeeded' && refund.refundedAt && Date.parse(refund.refundedAt) <= Date.parse(workspace.metrics.observedAt));
    const refunds = orderRefunds.reduce((sum, refund) => sum + (refund.direction === 'refund' ? (refund.amountCents ?? 0) : -(refund.amountCents ?? 0)), 0);
    const net = !refundsImported || order.paidAmountCents === null || orderRefunds.some((refund) => refund.amountCents === null) ? null : order.paidAmountCents - refunds;
    const productStatus = product ? null : order.productId ? '商品信息待补充' : '商品待匹配';
    return <tr key={order.id}><td><span className="table-primary">{order.externalOrderId}</span><span className="table-secondary">{platformLabel(order.platform)} · {creator?.accounts.find((account) => account.platform === order.platform)?.displayName ?? creator?.name ?? '未匹配达人'}</span></td><td>{product ? <><span className="table-primary">{product.name}</span><span className="table-secondary">SKU {order.sku ?? product.sku ?? '—'}</span></> : <><span className="table-primary">{productStatus}</span>{order.sku && <span className="table-secondary">SKU {order.sku}</span>}</>}</td><td>{formatDateTime(order.paidAt)}</td><td><StatusPill value={order.status} label={{ paid: '已支付', pending: '待支付', cancelled: '已取消', closed: '已关闭', unknown: '待核对' }[order.status]} />{canReconcile && ['pending', 'unknown'].includes(order.status) && <button className="link-button" onClick={() => onReconcile(order)}>核对订单</button>}</td><td className="numeric">{formatMoney(order.paidAmountCents)}{order.paidAmountCents === null && <span className="table-secondary">金额待补充</span>}</td><td className="numeric">{refundsImported ? formatMoney(net) : '待补充'}{!refundsImported ? <span className="table-secondary">退款信息待补充</span> : order.paidAmountCents === null ? <span className="table-secondary">金额待补充</span> : orderRefunds.some((refund) => refund.amountCents === null) ? <span className="table-secondary">退款金额待补充</span> : null}</td><td>{member?.displayName ?? '待补充'}<span className="table-secondary">{order.ownerSnapshot.reason === 'matched' ? '支付时负责人' : '待确认'}</span>{canCorrectOwner && <button className="link-button" onClick={() => onCorrectOwner(order)}>修改负责人</button>}</td></tr>;
  })}</tbody></table></div> : <EmptyState title="还没有订单数据" description={canImport ? '导入订单后查看订单数和成交金额。' : '管理员导入订单后，记录会显示在这里。'} action={canImport && <Button size="sm" onClick={onImport}><Upload size={14} />导入订单</Button>} />;
}

function RefundsTable({ refunds, orders, refundDataStatus, canReconcile, onReconcile, canImport, onImport }: { refunds: RefundEvent[]; orders: OrderLine[]; refundDataStatus: 'not_imported' | 'records_only' | 'not_visible'; canReconcile: boolean; onReconcile: (refund: RefundEvent) => void; canImport: boolean; onImport: () => void }) {
  return refunds.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>退款</th><th>订单</th><th>退款时间</th><th>状态</th><th className="numeric">退款金额</th></tr></thead><tbody>{refunds.map((refund) => {
    const order = orders.find((item) => item.id === refund.orderLineId);
    return <tr key={refund.id}><td><span className="table-primary">{refund.externalRefundId}</span><span className="table-secondary">{platformLabel(refund.platform)} · {refund.direction === 'refund' ? '退款' : '冲正'}</span></td><td>{order?.externalOrderId ?? '待补充'}</td><td>{formatDateTime(refund.refundedAt)}</td><td><StatusPill value={refund.status} label={{ succeeded: '已成功', pending: '处理中', reversed: '已冲正', unknown: '待核对' }[refund.status]} />{canReconcile && ['pending', 'unknown'].includes(refund.status) && <button className="link-button" onClick={() => onReconcile(refund)}>核对退款</button>}</td><td className="numeric">{formatMoney(refund.amountCents)}{refund.amountCents === null && <span className="table-secondary">金额待补充</span>}</td></tr>;
  })}</tbody></table></div> : <EmptyState title={refundDataStatus === 'records_only' ? '暂无退款' : refundDataStatus === 'not_imported' ? '尚未导入退款' : '退款信息待补充'} description={refundDataStatus === 'not_imported' ? '导入退款后查看退款后金额。' : undefined} action={canImport && refundDataStatus === 'not_imported' && <Button size="sm" onClick={onImport}><Upload size={14} />导入退款</Button>} />;
}

function CsvImportDialog({ open, onOpenChange, onCommitted }: { open: boolean; onOpenChange: (open: boolean) => void; onCommitted: () => Promise<void> }) {
  const { run } = useWorkbench();
  const fileRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<ImportKind>('creators');
  const [sourceName, setSourceName] = useState('');
  const [csvText, setCsvText] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<CsvPreviewResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fields = requiredColumns[kind];
  const canCommit = Boolean(preview?.previewHash && preview.result) && preview?.validationErrors.length === 0;

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setPreview(null); setError(''); setMapping({});
    if (!file) { setCsvText(''); setSourceName(''); setHeaders([]); return; }
    if (!file.name.toLowerCase().endsWith('.csv')) { setError('请选择 CSV 文件。'); return; }
    if (file.size > 2_000_000) { setCsvText(''); setSourceName(''); setHeaders([]); setError('单个 CSV 文件不能超过 2,000,000 字节。'); if (fileRef.current) fileRef.current.value = ''; return; }
    try {
      const text = (await file.text()).replace(/^\uFEFF/u, '');
      setCsvText(text); setSourceName(file.name); setHeaders(readCsvHeaders(text));
    } catch { setError('文件读取失败，请重新选择。'); }
  }

  async function getTemplate() {
    try { const blob = await downloadCsvTemplate(kind); saveBlob(blob, `达播协作台-${kind}-导入模板.csv`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '模板下载失败'); }
  }

  async function handlePreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setPreview(null); setBusy(true);
    try {
      const columnMapping = Object.fromEntries(Object.entries(mapping).filter(([, header]) => header));
      const result = await previewCsvImport({ kind, csvText, sourceName, columnMapping });
      setPreview(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '预览失败，请重试。'); }
    finally { setBusy(false); }
  }

  async function handleCommit() {
    if (!preview?.previewHash || !canCommit) return;
    setError(''); setBusy(true);
    try {
      const columnMapping = Object.fromEntries(Object.entries(mapping).filter(([, header]) => header));
      const result = await commitCsvImport({ kind, csvText, sourceName, columnMapping, previewHash: preview.previewHash });
      await onCommitted();
      toast.success('导入完成，请查看导入结果。');
      setPreview(null); setCsvText(''); setHeaders([]); setSourceName(''); setMapping({}); if (fileRef.current) fileRef.current.value = '';
      if (result.notices?.length) toast.info(result.notices.join('；'));
    } catch (cause) { setError(cause instanceof Error ? cause.message : '提交失败，请重试。'); }
    finally { setBusy(false); }
  }

  function changeKind(next: ImportKind) { setKind(next); setPreview(null); setMapping({}); }

  return <Modal open={open} onOpenChange={(value) => { if (!value && busy) return; onOpenChange(value); }} title="导入业务数据" description="选择类型和文件，预览后确认导入。" className="modal-standard modal-wide">
    <form className="modal-form" onSubmit={handlePreview}>
      <div className="import-topline"><FormField label="导入类型" required><select className="native-select" value={kind} onChange={(event) => changeKind(event.target.value as ImportKind)}>{importKinds.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></FormField><Button type="button" variant="outline" onClick={() => void getTemplate()}><Download size={14} />下载标准模板</Button></div>
      <FormField label="CSV 文件" required hint="最大 2 MB。"><Input ref={fileRef} type="file" accept=".csv,text/csv" onChange={(event) => void chooseFile(event)} required={!csvText} /></FormField>
      {sourceName && <div className="selected-file"><FileUp size={15} /><span>{sourceName}</span></div>}
      {headers.length > 0 && <div className="mapping-panel"><div className="mapping-heading"><strong>匹配列</strong><span>已识别的列会自动匹配，可调整。</span></div>{fields.map((field) => <FormField key={field} label={columnLabels[field] ?? field}><select className="native-select" value={mapping[field] ?? ''} onChange={(event) => { setMapping((current) => ({ ...current, [field]: event.target.value })); setPreview(null); }}><option value="">自动匹配</option>{headers.map((header) => <option key={header} value={header}>{header}</option>)}</select></FormField>)}<details className="optional-mapping"><summary>匹配其他信息</summary><div className="mapping-optional-grid">{optionalColumns[kind].map((field) => <FormField key={field} label={columnLabels[field] ?? field}><select className="native-select" value={mapping[field] ?? ''} onChange={(event) => { setMapping((current) => ({ ...current, [field]: event.target.value })); setPreview(null); }}><option value="">自动匹配</option>{headers.map((header) => <option key={header} value={header}>{header}</option>)}</select></FormField>)}</div></details></div>}
      {preview && <ImportPreviewView preview={preview} />}
      {error && <div className="notice notice-error" role="alert">{error}</div>}
      <div className="modal-actions import-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>关闭</Button><Button type="submit" variant="outline" disabled={!csvText || busy}><RefreshCw size={14} />{busy ? '生成预览中…' : preview ? '重新预览' : '预览数据'}</Button>{preview && <Button type="button" onClick={() => void handleCommit()} disabled={!canCommit || busy}><Upload size={14} />{busy ? '正在导入…' : '确认导入'}</Button>}</div>
    </form>
  </Modal>;
}

function ImportPreviewView({ preview }: { preview: CsvPreviewResponse }) {
  const result = preview.result;
  const issues = result?.issues ?? [];
  const rowIssues = issues.slice(0, 8);
  const heading = result ? `${result.creates.creators + result.creates.orders + result.creates.refunds} 条新增 · ${result.duplicates.creators + result.duplicates.orders + result.duplicates.refunds} 条重复 · ${result.conflicts} 条冲突` : '暂时无法生成预览，请重新选择文件。';
  return <section className="import-preview" aria-label="CSV 导入预览">
    <div className="import-preview-heading"><div><strong>预览结果</strong><span>{preview.totalRows} 行 · {preview.sourceName}</span></div><strong>{heading}</strong></div>
    {preview.validationErrors.length > 0 && <div className="preview-issues"><strong>格式问题（{preview.validationErrors.length}）</strong>{preview.validationErrors.slice(0, 8).map((issue) => <div key={`${issue.rowNumber}-${issue.field ?? ''}`}>第 {issue.rowNumber} 行{issue.field ? ` · ${issue.field}` : ''}：{issue.message}</div>)}</div>}
    {rowIssues.length > 0 && <div className="preview-issues"><strong>待处理（{issues.length}）</strong>{rowIssues.map((issue: ImportIssue, index: number) => <div key={`${issue.rowNumber}-${issue.code}-${index}`}>第 {issue.rowNumber} 行 · {issue.message}</div>)}{issues.length > rowIssues.length && <span>另有 {issues.length - rowIssues.length} 条，可在导入记录中查看。</span>}</div>}
    <div className="table-wrap preview-table-wrap"><table className="data-table"><thead><tr><th>源行</th>{preview.headers.slice(0, 5).map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{preview.rows.slice(0, 6).map((row) => <tr key={row.rowNumber}><td>{row.rowNumber}</td>{preview.headers.slice(0, 5).map((header) => <td key={header}>{row.values[header] || '—'}</td>)}</tr>)}</tbody></table></div>
    {preview.totalRows > 6 && <span className="table-secondary">预览前 6 行，共 {preview.totalRows} 行。</span>}
  </section>;
}

function OwnerCorrectionDialog({ order, open, onOpenChange }: { order: OrderLine; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { workspace, run, running } = useWorkbench();
  const [error, setError] = useState('');
  const currentOwnerId = resolveOrderOwner(order, workspace.ownerCorrections);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); const form = new FormData(event.currentTarget);
    try {
      await run({ type: 'order.correctOwner', orderLineId: order.id, expectedVersion: order.version, correctedMemberId: String(form.get('memberId') ?? '') || null, correctedAt: shanghaiInputToIso(String(form.get('correctedAt') ?? '')), reason: String(form.get('reason') ?? '') });
      toast.success('订单负责人已更新'); onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '更正失败'); }
  }
  return <Modal open={open} onOpenChange={onOpenChange} title="修改订单负责人" description={`订单 ${order.externalOrderId}`}>
    <form className="modal-form" onSubmit={submit}>
      <div className="notice notice-warning">更改后，订单业绩会计入新的负责人。更正时间不能晚于当前时间。</div>
      <FormField label="负责人" required><select className="native-select" name="memberId" defaultValue={currentOwnerId ?? ''}><option value="">待补充</option>{workspace.members.filter((member) => member.active).map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select></FormField>
      <FormField label="更正时间" required><Input name="correctedAt" type="datetime-local" defaultValue={shanghaiDateTimeInput()} max={shanghaiDateTimeInput()} required /></FormField>
      <FormField label="更正说明" required><Textarea name="reason" rows={3} required placeholder="说明更正原因" /></FormField>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running}>{running ? '保存中…' : '确认更正'}</Button></div>
    </form>
  </Modal>;
}

function OrderReconciliationDialog({ order, open, onOpenChange }: { order: OrderLine; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { run, running } = useWorkbench();
  const [resolution, setResolution] = useState<'paid' | 'closed'>('paid');
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); const form = new FormData(event.currentTarget);
    const amount = String(form.get('paidAmount') ?? '').trim();
    try {
      await run({ type: 'order.reconcileSource', orderLineId: order.id, expectedVersion: order.version, resolution, sourceStatus: String(form.get('sourceStatus') ?? ''), paidAt: resolution === 'paid' && String(form.get('paidAt') ?? '') ? shanghaiInputToIso(String(form.get('paidAt') ?? '')) : null, paidAmountCents: resolution === 'paid' && amount ? Math.round(Number(amount) * 100) : null, rawAmount: resolution === 'paid' ? (amount || null) : null, creatorAccountId: String(form.get('creatorAccountId') ?? '') || null, sourceEvidenceUrl: String(form.get('sourceEvidenceUrl') ?? '') || null, reason: String(form.get('reason') ?? '') });
      toast.success('订单核对完成'); onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '核对失败'); }
  }
  return <Modal open={open} onOpenChange={onOpenChange} title="核对订单" description={`订单 ${order.externalOrderId}`}>
    <form className="modal-form" onSubmit={submit}><FormField label="核对结果" required><select className="native-select" value={resolution} onChange={(event) => setResolution(event.target.value as 'paid' | 'closed')}><option value="paid">已支付</option><option value="closed">已关闭（不计入成交金额）</option></select></FormField><FormField label="平台显示状态" required><Input name="sourceStatus" defaultValue={order.sourceStatus} required /></FormField>{resolution === 'paid' && <div className="form-grid"><FormField label="支付时间" required><Input name="paidAt" type="datetime-local" defaultValue={order.paidAt ? shanghaiDateTimeInput(new Date(order.paidAt)) : ''} required /></FormField><FormField label="成交金额（元）"><Input name="paidAmount" type="number" min={0} step="0.01" defaultValue={order.paidAmountCents === null ? '' : (order.paidAmountCents / 100).toFixed(2)} /></FormField></div>}<FormField label="达人抖音号"><Input name="creatorAccountId" defaultValue={order.creatorAccountId ?? ''} /></FormField><FormField label="订单凭证链接"><Input name="sourceEvidenceUrl" type="url" placeholder="https://" /></FormField><FormField label="核对说明" required><Textarea name="reason" rows={3} required placeholder="说明核对依据" /></FormField>{error && <p className="field-error" role="alert">{error}</p>}<div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running}>{running ? '保存中…' : '确认核对'}</Button></div></form>
  </Modal>;
}

function RefundReconciliationDialog({ refund, open, onOpenChange }: { refund: RefundEvent; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { run, running } = useWorkbench();
  const [resolution, setResolution] = useState<'succeeded' | 'reversed'>('succeeded');
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); const form = new FormData(event.currentTarget);
    const amount = String(form.get('amount') ?? '').trim();
    try {
      await run({ type: 'refund.reconcileSource', refundId: refund.id, expectedVersion: refund.version, resolution, sourceStatus: String(form.get('sourceStatus') ?? ''), refundedAt: shanghaiInputToIso(String(form.get('refundedAt') ?? '')), amountCents: amount ? Math.round(Number(amount) * 100) : null, rawAmount: amount || null, sourceEvidenceUrl: String(form.get('sourceEvidenceUrl') ?? '') || null, reason: String(form.get('reason') ?? '') });
      toast.success('退款核对完成'); onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '核对失败'); }
  }
  return <Modal open={open} onOpenChange={onOpenChange} title="核对退款" description={`退款 ${refund.externalRefundId}`}>
    <form className="modal-form" onSubmit={submit}><FormField label="核对结果" required><select className="native-select" value={resolution} onChange={(event) => setResolution(event.target.value as 'succeeded' | 'reversed')}><option value="succeeded">退款成功</option><option value="reversed">已冲正</option></select></FormField><FormField label="平台显示状态" required><Input name="sourceStatus" defaultValue={refund.sourceStatus} required /></FormField><div className="form-grid"><FormField label="退款时间" required><Input name="refundedAt" type="datetime-local" defaultValue={refund.refundedAt ? shanghaiDateTimeInput(new Date(refund.refundedAt)) : shanghaiDateTimeInput()} required /></FormField><FormField label="退款金额（元）"><Input name="amount" type="number" min={0} step="0.01" defaultValue={refund.amountCents === null ? '' : (refund.amountCents / 100).toFixed(2)} /></FormField></div><FormField label="退款凭证链接"><Input name="sourceEvidenceUrl" type="url" placeholder="https://" /></FormField><FormField label="核对说明" required><Textarea name="reason" rows={3} required /></FormField>{error && <p className="field-error" role="alert">{error}</p>}<div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running}>{running ? '保存中…' : '确认核对'}</Button></div></form>
  </Modal>;
}

function readCsvHeaders(text: string) {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell.length === 0) quoted = true;
    else if (char === ',') { cells.push(cell.trim()); cell = ''; }
    else if (char === '\n' || char === '\r') break;
    else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName; anchor.rel = 'noopener'; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
