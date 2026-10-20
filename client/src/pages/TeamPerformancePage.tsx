import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, Plus, RotateCcw, Users } from 'lucide-react';
import { useWorkbench } from '../workbench-context';
import { Button } from '../components/ui/button';
import SalesPerformancePanel from '../components/SalesPerformancePanel';
import BusinessProgressBoard from '../components/BusinessProgressBoard';
import PlatformTabs from '../components/PlatformTabs';
import { EmptyState as Empty, PageHeading, Panel, formatMoney } from '../components/workbench';
import TeamPage from './TeamPage';
import { buildOrdersDrilldownHref, buildShopFilterOptions, buildTeamPerformanceRows, decodeShopFilterValue, encodeShopFilterValue } from '../lib/team-performance';
import { getNavigationModules } from '../lib/navigation';
import { getBusinessOrderSourceStatus } from '../lib/business-home';
import { normalizeOrderViewPlatform, summarizeOrderViewMetrics } from '../lib/order-view';
import { platformLabel } from '../lib/platform-presentation';
import { summarizeSalesPerformance } from '../lib/sales-performance';
import { resolveOrderOwner } from '@shared/order-view';
import type { TeamPerformanceMemberIdentity, TeamPerformanceOrderRow, TeamPerformanceCreatorRow, TeamPerformanceSampleRow } from '../lib/team-performance';
import '../team-performance.css';

type MetricView = 'orders' | 'creators' | 'samples' | 'sales';
type TopView = 'performance' | 'management' | 'progress';

function todayKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function monthStart() {
  return `${todayKey().slice(0, 7)}-01`;
}

export default function TeamPerformancePage() {
  const { workspace, session } = useWorkbench();
  const [searchParams, setSearchParams] = useSearchParams();
  const [salesFormOpen, setSalesFormOpen] = useState(false);
  const actor = session.actor;
  const modules = useMemo(() => getNavigationModules({
    role: actor.role,
    capabilities: actor.capabilities,
    canSeeTeamMetrics: workspace.scope.canSeeTeamMetrics,
  }), [actor.role, actor.capabilities, workspace.scope.canSeeTeamMetrics]);
  const dataModule = modules.find((module) => module.id === 'data');
  const teamModule = modules.find((module) => module.id === 'team');
  const canSeeOrders = Boolean(dataModule?.routes.some((route) => route.id === 'orders'));
  const canSeeTeamMetrics = workspace.scope.canSeeTeamMetrics && Boolean(dataModule?.routes.some((route) => route.id === 'dashboard'));
  const canSeePerformance = canSeeOrders || canSeeTeamMetrics;
  const canManageTeam = (actor.role === 'admin' || actor.role === 'manager') && Boolean(teamModule?.routes.some((route) => route.id === 'team'));
  const canUseSalesReports = actor.role !== 'ops';

  const platform = normalizeOrderViewPlatform(searchParams.get('platform'));
  const dateFrom = searchParams.has('dateFrom') ? searchParams.get('dateFrom') ?? '' : monthStart();
  const dateTo = searchParams.has('dateTo') ? searchParams.get('dateTo') ?? '' : todayKey();
  const allowedTeamIds = new Set(workspace.scope.teamIds);
  const allowedTeams = workspace.teams.filter((team) => allowedTeamIds.has(team.id));
  const requestedTeamId = searchParams.get('teamId') ?? 'all';
  const teamId = requestedTeamId === 'all' || allowedTeamIds.has(requestedTeamId) ? requestedTeamId : 'all';
  const selectableMembers = workspace.members.filter((member) => allowedTeamIds.has(member.teamId) && (teamId === 'all' || member.teamId === teamId));
  const requestedOwner = searchParams.get('ownerMemberId') ?? 'all';
  const ownerMemberId = actor.role === 'bd'
    ? actor.memberId
    : requestedOwner === 'all' || selectableMembers.some((member) => member.id === requestedOwner) ? requestedOwner : 'all';
  const shopId = searchParams.get('shopId') ?? 'all';
  const shopPlatform = normalizeOrderViewPlatform(searchParams.get('shopPlatform'));
  const requestedTab = searchParams.get('tab');
  const view: TopView = canManageTeam && requestedTab === 'progress'
    ? 'progress'
    : canManageTeam && requestedTab === 'management'
      ? 'management'
      : canSeePerformance || canUseSalesReports ? 'performance' : 'management';
  const requestedMetric = searchParams.get('metric');
  const metric: MetricView = requestedMetric === 'creators' || requestedMetric === 'samples' || (requestedMetric === 'sales' && canUseSalesReports) ? requestedMetric : 'orders';

  const rows = useMemo(() => buildTeamPerformanceRows({
    workspace,
    actor,
    filters: { dateFrom, dateTo, platform, shopId, shopPlatform, teamId, ownerMemberId },
  }), [workspace, actor.memberId, actor.role, dateFrom, dateTo, platform, shopId, shopPlatform, teamId, ownerMemberId]);
  const orderSourceStatus = getBusinessOrderSourceStatus({
    orders: workspace.orders,
    importBatches: workspace.importBatches,
    importHistoryVisible: workspace.metrics.dataCoverage.importHistoryVisible,
  });
  const refundsImported = workspace.metrics.dataCoverage.refundDataStatus === 'records_only';
  const orderMetrics = useMemo(() => summarizeOrderViewMetrics({
    orders: rows.visibleOrders,
    visibleRefunds: rows.visibleRefunds,
    allRefunds: rows.cohortRefunds,
    orderSourceAvailable: orderSourceStatus === 'records_only',
    refundSourceAvailable: refundsImported,
    observedAt: workspace.metrics.observedAt,
    getOrderOwner: (order) => resolveOrderOwner(order, workspace.ownerCorrections),
  }), [rows, orderSourceStatus, refundsImported, workspace.metrics.observedAt, workspace.ownerCorrections]);

  const shopOptions = useMemo(() => buildShopFilterOptions({
    stores: workspace.manualStores,
    orders: workspace.orders,
    allowedTeamIds: teamId === 'all' ? workspace.scope.teamIds : workspace.scope.teamIds.includes(teamId) ? [teamId] : [],
    platformFilter: platform,
    selectedShopId: shopId,
    selectedShopPlatform: shopPlatform,
  }), [workspace.manualStores, workspace.orders, workspace.scope.teamIds, teamId, platform, shopId, shopPlatform]);
  const shopSelectValue = shopId === 'all' ? 'all' : encodeShopFilterValue(shopId, shopPlatform);
  const salesSummary = useMemo(() => summarizeSalesPerformance({
    workspace,
    actor,
    filters: { dateFrom, dateTo, platform, shopId, shopPlatform, teamId, ownerMemberId, status: 'all' },
  }), [workspace, actor.memberId, actor.role, dateFrom, dateTo, platform, shopId, shopPlatform, teamId, ownerMemberId]);

  function setParam(name: string, value: string, omitValue = 'all') {
    const next = new URLSearchParams(searchParams);
    if (value === omitValue) next.delete(name);
    else next.set(name, value);
    setSearchParams(next, { replace: true });
  }

  function setPlatform(value: string) {
    const next = new URLSearchParams(searchParams);
    if (value === 'all') next.delete('platform'); else next.set('platform', value);
    if (shopId !== 'all' && shopPlatform !== 'all' && value !== 'all' && value !== shopPlatform) {
      next.delete('shopId');
      next.delete('shopPlatform');
    }
    setSearchParams(next, { replace: true });
  }

  function setShopFilter(value: string) {
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
  }

  function setTeam(value: string) {
    const next = new URLSearchParams(searchParams);
    if (value === 'all') next.delete('teamId');
    else next.set('teamId', value);
    next.delete('ownerMemberId');
    setSearchParams(next, { replace: true });
  }

  function setTopView(nextView: TopView) {
    const next = new URLSearchParams(searchParams);
    next.set('tab', nextView);
    setSearchParams(next, { replace: true });
  }

  function setMetricView(nextMetric: MetricView) {
    const next = new URLSearchParams(searchParams);
    if (nextMetric === 'orders') next.delete('metric');
    else next.set('metric', nextMetric);
    setSearchParams(next, { replace: true });
  }

  function openSalesForm() {
    const next = new URLSearchParams(searchParams);
    next.set('tab', 'performance');
    next.set('metric', 'sales');
    setSearchParams(next, { replace: true });
    setSalesFormOpen(true);
  }

  function resetFilters() {
    const next = new URLSearchParams(searchParams);
    for (const key of ['dateFrom', 'dateTo', 'shopId', 'shopPlatform', 'teamId', 'ownerMemberId', 'platform']) next.delete(key);
    setSearchParams(next, { replace: true });
  }

  function ordersHref() {
    return buildOrdersDrilldownHref({ searchParams, dateFrom, dateTo, platform, shopId, shopPlatform, teamId, ownerMemberId, actor });
  }

  const orderAmount = orderMetrics.paidOrders.amount;
  const refundAmount = orderMetrics.refunds.amount;
  const refundAmountValue = refundAmount ? formatMoney(refundAmount.knownCents) : '待补充';

  const orderKnownCents = orderSourceStatus === 'records_only' ? orderAmount?.knownCents ?? 0 : 0;
  const countedPerformanceCents = orderKnownCents + salesSummary.countedManualCents;
  const noOrderRows = workspace.orders.length === 0;
  const performanceAmountNote = noOrderRows
    ? '导入订单后这里显示成交金额'
    : `${formatMoney(orderKnownCents)} 来自订单${salesSummary.countedCount ? `，另有 ${salesSummary.countedCount} 条已核对填报` : ''}`;
  const currentBrandName = session.businessWorkspace?.brandName ?? session.workbook?.brandName ?? '当前品牌';

  if (!canSeePerformance && !canManageTeam && !canUseSalesReports) {
    return <div className="page-stack team-performance-page"><PageHeading title="团队与业绩" /><Empty title="当前角色没有可见的业绩数据" description="此工作区没有开放订单业绩查看权限。" icon={<Users size={21} />} /></div>;
  }

  return <div className="page-stack team-performance-page">
    <PageHeading title={view === 'progress' ? '商务进度' : '团队与业绩'} description={`${currentBrandName} · ${view === 'progress' ? '查看商务推进和合作执行。' : noOrderRows ? '还没有订单数据' : '订单金额和已核对的填报分开显示。'}`} actions={view === 'progress' ? undefined : <div className="team-performance-title-actions">{canUseSalesReports && <Button onClick={openSalesForm}><Plus size={15} />录入带货业绩</Button>}{canSeeOrders && <Link className="button button-outline" to={ordersHref()}>{noOrderRows ? '导入订单' : '订单与退款明细'}<ArrowUpRight size={14} /></Link>}</div>} />
    <div className="team-performance-top-tabs" role="group" aria-label="团队与业绩视图">
      {(canSeePerformance || canUseSalesReports) && <button type="button" aria-pressed={view === 'performance'} onClick={() => setTopView('performance')}>业绩</button>}
      {canManageTeam && <button type="button" aria-pressed={view === 'management'} onClick={() => setTopView('management')}>团队管理</button>}
      {canManageTeam && <button type="button" aria-pressed={view === 'progress'} onClick={() => setTopView('progress')}>商务进度</button>}
    </div>
    {view === 'progress' && canManageTeam ? <BusinessProgressBoard snapshot={workspace.businessProgress} /> : view === 'management' && canManageTeam ? <div className="team-performance-management"><TeamPage embedded /></div> : canSeePerformance || canUseSalesReports ? <>
      {canSeePerformance && <PlatformTabs value={platform} onChange={setPlatform} allowAll variant="pill" label="按平台筛选业绩" />}
      <Panel title="筛选范围">
        <div className="team-performance-filters">
          <label className="team-performance-filter">店铺<select className="native-select" value={shopSelectValue} onChange={(event) => setShopFilter(event.target.value)} aria-label="筛选店铺"><option value="all">全部店铺</option>{shopOptions.map((option) => <option key={encodeShopFilterValue(option.shopId, option.shopPlatform)} value={encodeShopFilterValue(option.shopId, option.shopPlatform)}>{option.shopPlatform === 'all' ? '全部平台' : platformLabel(option.shopPlatform)} · {option.name}</option>)}</select></label>
          {workspace.scope.canSeeTeamMetrics && allowedTeams.length > 1 && <label className="team-performance-filter">团队<select className="native-select" value={teamId} onChange={(event) => setTeam(event.target.value)} aria-label="筛选团队"><option value="all">全部团队</option>{allowedTeams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>}
          <label className="team-performance-filter">成员<select className="native-select" value={ownerMemberId} disabled={actor.role === 'bd'} onChange={(event) => setParam('ownerMemberId', event.target.value)} aria-label="筛选成员">{actor.role === 'bd' ? <option value={actor.memberId}>{session.actor.displayName}（我的业绩）</option> : <><option value="all">全部成员</option>{selectableMembers.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</>}</select></label>
          <label className="team-performance-filter">开始日期<input type="date" className="filter-input" value={dateFrom} onChange={(event) => setParam('dateFrom', event.target.value, '__never__')} aria-label="开始日期" /></label>
          <label className="team-performance-filter">结束日期<input type="date" className="filter-input" value={dateTo} onChange={(event) => setParam('dateTo', event.target.value, '__never__')} aria-label="结束日期" /></label>
          <Button variant="outline" size="sm" className="team-performance-reset" onClick={resetFilters}><RotateCcw size={14} />重置</Button>
        </div>
        <p className="team-performance-filter-note">店铺筛选同步作用于订单与该平台店铺的手工填报；日期按订单支付日或填报归属日统计。当前品牌：{currentBrandName}。</p>
      </Panel>
      {noOrderRows ? <Empty title="还没有订单数据" description="导入平台订单后，这里会显示成交金额和成员指标。" /> : <div className="team-performance-overview" aria-label="订单与手工业绩合计">
        <div className="team-performance-overview-item"><span>计入业绩金额</span><strong>{orderAmount && !orderAmount.complete && orderAmount.knownCents === 0 ? '金额待补充' : formatMoney(countedPerformanceCents)}</strong><small>{performanceAmountNote}</small></div>
        <div className="team-performance-overview-item"><span>支付明细数</span><strong>{orderMetrics.paidOrders.count ?? '—'}</strong><small>{orderMetrics.paidOrders.unassignedCount ? `未归属 ${orderMetrics.paidOrders.unassignedCount} 条` : '按支付时间统计'}</small></div>
        <div className="team-performance-overview-item"><span>退款金额</span><strong>{refundAmountValue === '待补充' ? '—' : refundAmountValue}</strong><small>{refundsImported ? (refundAmount?.unknownCount ? `${refundAmount.unknownCount} 条金额还没填` : '已导入的退款') : '还没有退款数据'}</small></div>
        <div className="team-performance-overview-item"><span>退款事件数</span><strong>{orderMetrics.refunds.count ?? '—'}</strong><small>{refundsImported ? '按退款时间统计' : '还没有退款数据'}</small></div>
      </div>}
      <Panel title={metric === 'sales' ? '带货业绩填报' : '成员指标'} description={metricDescription(metric)} action={<>{canUseSalesReports && metric === 'sales' && <Button size="sm" onClick={() => setSalesFormOpen(true)}><Plus size={14} />录入带货业绩</Button>}{canSeeOrders && <Link className="link-button" to={ordersHref()}>订单与退款明细<ArrowUpRight size={12} /></Link>}</>}>
        <div className="team-performance-metric-tabs" role="group" aria-label="成员指标类型">
          {canSeePerformance && <button type="button" aria-pressed={metric === 'orders'} onClick={() => setMetricView('orders')}>订单业绩</button>}
          {canSeePerformance && <button type="button" aria-pressed={metric === 'creators'} onClick={() => setMetricView('creators')}>达人指标</button>}
          {canSeePerformance && <button type="button" aria-pressed={metric === 'samples'} onClick={() => setMetricView('samples')}>寄样指标</button>}
          {canUseSalesReports && <button type="button" aria-pressed={metric === 'sales'} onClick={() => setMetricView('sales')}>业绩填报{salesSummary.pendingReviewCount + salesSummary.reconciliationRequiredCount > 0 && <span className="team-performance-tab-count">{salesSummary.pendingReviewCount + salesSummary.reconciliationRequiredCount}</span>}</button>}
        </div>
        {metric === 'orders' && <OrderPerformanceTable rows={rows.orders} sourceAvailable={orderSourceStatus === 'records_only'} />}
        {metric === 'creators' && <CreatorPerformanceTable rows={rows.creators} />}
        {metric === 'samples' && <SamplePerformanceTable rows={rows.samples} />}
        {canUseSalesReports && metric === 'sales' && <SalesPerformancePanel filters={{ dateFrom, dateTo, platform, shopId, shopPlatform, teamId, ownerMemberId }} formOpen={salesFormOpen} onFormOpenChange={setSalesFormOpen} orderSourceAvailable={orderSourceStatus === 'records_only'} orderUnknownCount={orderAmount?.unknownCount ?? 0} />}
      </Panel>
    </> : <Empty title="当前角色没有可见的业绩数据" description="此工作区没有开放订单业绩查看权限。" icon={<Users size={21} />} />}
  </div>;
}

function metricDescription(metric: MetricView) {
  if (metric === 'sales') return '商务按直播场次或短视频统计周期填报支付成交金额；负责人核对后计入手工贡献。退款金额仍以导入明细为准。';
  if (metric === 'creators') return '按达人档案创建时间统计，阶段为当前状态。';
  if (metric === 'samples') return '按申请人统计申请记录；同一申请有多个包裹时仍只计一项待签收申请。';
  return '按订单支付金额汇总到负责成员。金额还没填的订单会单独标出。';
}

function MemberCell({ row }: { row: TeamPerformanceMemberIdentity }) {
  return <span className="team-performance-member"><strong>{row.memberName}</strong><small>{row.teamName}</small></span>;
}

function OrderPerformanceTable({ rows, sourceAvailable }: { rows: TeamPerformanceOrderRow[]; sourceAvailable: boolean }) {
  if (!sourceAvailable) return <Empty title="还没有订单数据" description="导入平台订单后，这里显示每位成员的成交金额。" />;
  if (!rows.length) return <Empty title="当前筛选范围暂无订单业绩" description="调整日期、平台、店铺或成员筛选。" />;
  return <div className="table-wrap team-performance-table-wrap"><table className="data-table team-performance-table"><thead><tr><th>成员 / 团队</th><th className="numeric">支付明细数</th><th className="numeric">支付成交金额</th><th className="numeric">退款事件数</th><th className="numeric">退款金额（含冲正）</th></tr></thead><tbody>{rows.map((row) => <tr key={row.memberId}><td><MemberCell row={row} /></td><td className="numeric">{row.paidOrderCount}{row.paidUnknownCount > 0 && <span className="table-secondary">{row.paidUnknownCount} 条金额待补</span>}</td><td className="numeric">{formatMoney(row.paidKnownCents)}{row.paidUnknownCount > 0 && <span className="table-secondary">已知金额小计</span>}</td><td className="numeric">{row.refundEventCount}{row.refundUnknownCount > 0 && <span className="table-secondary">{row.refundUnknownCount} 条金额待补</span>}</td><td className="numeric">{formatMoney(row.refundSignedCents)}{row.refundUnknownCount > 0 && <span className="table-secondary">已知金额小计</span>}</td></tr>)}</tbody></table></div>;
}

function CreatorPerformanceTable({ rows }: { rows: TeamPerformanceCreatorRow[] }) {
  if (!rows.length) return <Empty title="当前筛选范围暂无达人记录" description="调整日期、平台、团队或成员筛选。" />;
  return <div className="table-wrap team-performance-table-wrap"><table className="data-table team-performance-table"><thead><tr><th>成员 / 团队</th><th className="numeric">新增达人</th><th className="numeric">有回应</th><th className="numeric">洽谈中</th><th className="numeric">合作中</th></tr></thead><tbody>{rows.map((row) => <tr key={row.memberId}><td><MemberCell row={row} /></td><td className="numeric">{row.creatorCount}</td><td className="numeric">{row.respondedCount}</td><td className="numeric">{row.negotiatingCount}</td><td className="numeric">{row.cooperatingCount}</td></tr>)}</tbody></table></div>;
}

function SamplePerformanceTable({ rows }: { rows: TeamPerformanceSampleRow[] }) {
  if (!rows.length) return <Empty title="当前筛选范围暂无寄样记录" description="调整日期、平台、团队或成员筛选。" />;
  return <div className="table-wrap team-performance-table-wrap"><table className="data-table team-performance-table"><thead><tr><th>成员 / 团队</th><th className="numeric">申请数</th><th className="numeric">申请件数</th><th className="numeric">待审核</th><th className="numeric">待发货</th><th className="numeric">待签收申请</th><th className="numeric">已签收申请</th></tr></thead><tbody>{rows.map((row) => <tr key={row.memberId}><td><MemberCell row={row} /></td><td className="numeric">{row.requestCount}</td><td className="numeric">{row.requestedUnitCount}</td><td className="numeric">{row.pendingApprovalCount}</td><td className="numeric">{row.pendingShipmentCount}</td><td className="numeric">{row.waitingReceiptRequestCount}</td><td className="numeric">{row.receivedCount}</td></tr>)}</tbody></table></div>;
}
