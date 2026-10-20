import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, CalendarClock, Download, PackageCheck, RotateCcw, Users } from 'lucide-react';
import type { CrmStage, WorkspaceSnapshot } from '@shared/types';
import { useWorkbench } from '../workbench-context';
import { getWorkspace } from '../api';
import { Button } from '../components/ui/button';
import { EmptyState, MetricTile, PageHeading, Panel, StatusPill, formatCompactMoney, formatMoney, shanghaiDateKey } from '../components/workbench';
import { compareTimestamps } from '../lib/time';
import { getBusinessOrderSourceStatus } from '../lib/business-home';
import '../business-surfaces.css';

const funnelStages: CrmStage[] = ['contacted', 'responded', 'negotiating', 'cooperating'];
const stageLabels: Record<CrmStage, string> = { uncontacted: '未建联', contacted: '已触达', responded: '有回应', negotiating: '洽谈中', cooperating: '合作中', paused: '暂停', declined: '不合作' };
const colors = { blue: '#2b62d4', green: '#20835b', orange: '#c08029', grid: '#edf0f4', text: '#8692a1' };

function todayKey() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function monthStart() { return `${todayKey().slice(0, 7)}-01`; }

export default function DashboardPage() {
  const { workspace: base, session } = useWorkbench();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayKey());
  const [ownerMemberId, setOwnerMemberId] = useState('all');
  const [teamId, setTeamId] = useState('all');
  const allowedTeams = base.teams.filter((team) => base.scope.teamIds.includes(team.id));
  const teamScope = base.actor.role === 'manager' || base.actor.role === 'admin';
  const actorCacheKey = `${session.actor.principalId}:${session.actor.role}:${[...session.actor.capabilities].sort().join(',')}`;
  const drilldown = (path: string, extra: Record<string, string> = {}) => {
    const params = new URLSearchParams();
    if (from) params.set('dateFrom', from);
    if (to) params.set('dateTo', to);
    if (teamId !== 'all') params.set('teamId', teamId);
    if (ownerMemberId !== 'all') params.set('ownerMemberId', ownerMemberId);
    for (const [key, value] of Object.entries(extra)) params.set(key, value);
    const suffix = params.toString();
    return suffix ? `${path}?${suffix}` : path;
  };
  const snapshotQuery = useQuery({
    queryKey: ['workspace', 'dashboard', session.dataMode, session.businessWorkspace?.brandId ?? 'demo', actorCacheKey, from, to, ownerMemberId, teamId],
    queryFn: () => getWorkspace({ dateFrom: from || undefined, dateTo: to || undefined, ownerMemberId: ownerMemberId === 'all' ? undefined : ownerMemberId, teamId: teamId === 'all' ? undefined : teamId }, session.businessWorkspace?.brandId),
  });
  const data = snapshotQuery.data ?? base;
  const metrics = data.metrics;
  const refundsImported = metrics.dataCoverage.refundDataStatus === 'records_only';
  const orderSourceStatus = getBusinessOrderSourceStatus({ orders: data.orders, importBatches: data.importBatches, importHistoryVisible: metrics.dataCoverage.importHistoryVisible });
  const chart = useMemo(() => buildTrend(data.orders, refundsImported ? data.refunds : []), [data.orders, data.refunds, refundsImported]);
  const ranking = useMemo(() => buildRanking(data.orders, data.ownerCorrections, data.members, from, to), [data.orders, data.ownerCorrections, data.members, from, to]);
  const funnel = funnelStages.map((stage, index) => {
    const count = metrics.funnel.byStage[stage] ?? 0;
    const denominator = index === 0 ? metrics.funnel.cohortSize : metrics.funnel.byStage[funnelStages[index - 1]] ?? 0;
    return { stage, label: stageLabels[stage], count, denominator, rate: denominator > 0 ? count / denominator : null };
  });
  const issues = data.importBatches.flatMap((batch) => batch.issues.map((issue) => ({ batch, issue }))).slice(0, 5);
  const refundMetricLabel = '退款';
  const refundMetricValue = refundsImported ? formatCompactMoney(metrics.refunds.amount) : '待补充';
  const refundMetricSub = refundsImported ? metrics.refunds.unknownCount ? `${metrics.refunds.count} 笔退款 · ${metrics.refunds.unknownCount} 笔金额待补充` : `${metrics.refunds.count} 笔退款` : '退款信息待补充';

  return <div className="page-stack business-dashboard-page">
    <PageHeading title="团队看板" actions={<Link className="button button-outline" to={drilldown('/orders')}><Download size={14} />订单明细</Link>} />
    <Panel title="筛选范围">
      <div className="dashboard-filters"><label>支付 / 退款日期<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} aria-label="统计开始日期" /></label><span>至</span><label>结束日期<input type="date" value={to} onChange={(event) => setTo(event.target.value)} aria-label="统计结束日期" /></label>{allowedTeams.length > 1 && <label>团队<select value={teamId} onChange={(event) => { setTeamId(event.target.value); setOwnerMemberId('all'); }} aria-label="按团队筛选"><option value="all">全部团队</option>{allowedTeams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>}<label>负责人<select value={ownerMemberId} onChange={(event) => setOwnerMemberId(event.target.value)} aria-label="按负责人筛选"><option value="all">全部负责人</option>{data.members.filter((member) => teamId === 'all' || member.teamId === teamId).map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select></label><Button variant="outline" size="sm" onClick={() => { setFrom(''); setTo(''); setOwnerMemberId('all'); setTeamId('all'); }}><RotateCcw size={13} />重置</Button></div>
      {snapshotQuery.isFetching && <span className="refresh-hint">正在刷新指标…</span>}
      {snapshotQuery.error && <div className="notice notice-error" role="alert">{snapshotQuery.error instanceof Error ? snapshotQuery.error.message : '更新失败，请重试。'}</div>}
    </Panel>
    <div className="page-grid metrics-grid">
      <MetricTile label="有效达人" value={metrics.creators.assigned} sub={`公海 ${metrics.creators.public} 位`} icon={<Users size={15} />} href={drilldown('/creators', { scope: teamScope ? 'team' : 'mine' })} tone="blue" />
      <MetricTile label="开放合作" value={Object.entries(metrics.cooperations).filter(([key]) => !['delivered', 'cancelled', 'rejected'].includes(key)).reduce((sum, [, value]) => sum + value, 0)} sub={`待交付 ${metrics.cooperations.pending_delivery}`} icon={<PackageCheck size={15} />} href={drilldown('/cooperations')} tone="orange" />
      <MetricTile label="成交金额" value={orderSourceStatus === 'records_only' ? formatCompactMoney(metrics.paidOrders.amount.knownCents) : '待补充'} sub={orderSourceStatus !== 'records_only' ? '订单信息待补充' : metrics.paidOrders.amount.complete ? `${metrics.paidOrders.count} 笔订单` : `${metrics.paidOrders.count} 笔订单 · ${metrics.paidOrders.amount.unknownCount} 笔金额待补充`} icon={<Download size={15} />} href={drilldown('/orders')} tone="green" />
      <MetricTile label={refundMetricLabel} value={refundMetricValue} sub={refundMetricSub} icon={<RotateCcw size={15} />} href={drilldown('/orders')} tone="neutral" />
    </div>
    <div className="dashboard-grid-main">
      <Panel title="订单与退款趋势">
        {chart.length ? <div className="chart-wrap" role="img" aria-label="订单成交金额和退款趋势图"><ResponsiveContainer width="100%" height={260}><LineChart data={chart} margin={{ top: 10, right: 18, left: 4, bottom: 0 }}><CartesianGrid stroke={colors.grid} vertical={false} /><XAxis dataKey="date" tick={{ fill: colors.text, fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={24} tickFormatter={(value) => String(value).slice(5)} /><YAxis tick={{ fill: colors.text, fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(value) => `¥${Number(value).toLocaleString('zh-CN')}`} width={60} /><Tooltip formatter={(value) => formatYuan(typeof value === 'number' ? value : Number(value))} labelFormatter={(value) => `日期 ${value}`} /><Line type="monotone" dataKey="paidYuan" name="成交金额" stroke={colors.blue} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />{refundsImported && <Line type="monotone" dataKey="refundYuan" name="退款" stroke={colors.orange} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />}</LineChart></ResponsiveContainer></div> : <EmptyState title="暂无趋势数据" description="导入订单后查看趋势。" />}
        {chart.length > 0 && <div className="chart-legend"><span><i className="legend-blue" />成交金额</span>{refundsImported && <span><i className="legend-orange" />退款</span>}</div>}
      </Panel>
      <Panel title="达人建联进度">
        <div className="funnel-list">{funnel.map((item, index) => <div className="funnel-row" key={item.stage}><div className="funnel-row-head"><strong>{item.label}</strong><span>{item.count}<small> 人</small></span></div><div className="funnel-track"><span style={{ width: `${metrics.funnel.cohortSize ? Math.max(2, item.count / metrics.funnel.cohortSize * 100) : 0}%`, opacity: 1 - index * .1 }} /></div><div className="funnel-foot"><span>{index === 0 ? '建联人数' : `转化率 ${item.rate === null ? '—' : `${(item.rate * 100).toFixed(1)}%`}`}</span></div></div>)}</div>
        <Link className="panel-inline-link" to={drilldown('/creators', { scope: teamScope ? 'team' : 'mine' })}>查看达人阶段明细 <span>→</span></Link>
      </Panel>
    </div>
    <div className="dashboard-grid-bottom">
      <Panel title="成员成交排行">
        {ranking.length ? <div className="chart-wrap rank-chart" role="img" aria-label="成员订单成交金额排行"><ResponsiveContainer width="100%" height={Math.max(210, ranking.length * 44)}><BarChart data={ranking.slice(0, 8)} layout="vertical" margin={{ top: 3, right: 18, left: 10, bottom: 2 }}><CartesianGrid stroke={colors.grid} horizontal={false} /><XAxis type="number" tick={{ fill: colors.text, fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(value) => `¥${Number(value).toLocaleString('zh-CN')}`} /><YAxis type="category" dataKey="name" width={75} tick={{ fill: '#526073', fontSize: 11 }} tickLine={false} axisLine={false} /><Tooltip formatter={(value) => formatYuan(typeof value === 'number' ? value : Number(value))} labelFormatter={(value) => `${value} · 成交金额`} /><Bar dataKey="paidYuan" name="成交金额" fill={colors.blue} radius={[0, 4, 4, 0]} barSize={15} /></BarChart></ResponsiveContainer></div> : <EmptyState title="暂无成员业绩" description="导入订单后查看业绩。" />}
        {ranking.length > 0 && metrics.paidOrders.unassignedCount > 0 && <div className="rank-table-note">未分配订单 {metrics.paidOrders.unassignedCount} 笔 · 金额 {formatMoney(metrics.paidOrders.unassignedKnownCents)}</div>}
      </Panel>
      <Panel title="待办事项">
        <div className="attention-list">
          <Link to={drilldown('/tasks')} className="attention-item"><span className="attention-icon warning"><CalendarClock size={15} /></span><span><strong>逾期任务</strong><small>{metrics.overdueTasks.count} 条，按当前负责人查看</small></span><b>{metrics.overdueTasks.count}</b></Link>
          <Link to={drilldown('/samples')} className="attention-item"><span className="attention-icon orange"><PackageCheck size={15} /></span><span><strong>样品待履约</strong><small>待审批 / 待发货 / 待签收包裹</small></span><b>{metrics.sampleBacklog.pendingApproval + metrics.sampleBacklog.pendingShipment + metrics.sampleBacklog.pendingReceiptPackages}</b></Link>
          <Link to={drilldown('/schedule')} className="attention-item"><span className="attention-icon blue"><CalendarClock size={15} /></span><span><strong>逾期排期</strong><small>计划时间已过，尚未标记完成</small></span><b>{metrics.schedules.overdue}</b></Link>
          <Link to={drilldown('/orders')} className="attention-item"><span className="attention-icon neutral"><AlertTriangle size={15} /></span><span><strong>订单待处理</strong><small>未分配订单与导入问题</small></span><b>{metrics.dataCoverage.issues + metrics.dataCoverage.unassignedOrderCount}</b></Link>
        </div>
        {issues.length > 0 && <div className="attention-issues"><strong>最近待核对</strong>{issues.slice(0, 3).map(({ batch, issue }) => <div key={`${batch.id}-${issue.rowNumber}-${issue.code}`}><span>第 {issue.rowNumber} 行 · {issue.message}</span><small>{batch.sourceName}</small></div>)}</div>}
      </Panel>
    </div>
  </div>;
}

function formatYuan(amount: number) {
  return `¥${new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)}`;
}

function buildTrend(orders: WorkspaceSnapshot['orders'], refunds: WorkspaceSnapshot['refunds']) {
  const data = new Map<string, { date: string; paidCents: number; refundCents: number; unknownCount: number }>();
  const ensure = (key: string) => { if (!data.has(key)) data.set(key, { date: key, paidCents: 0, refundCents: 0, unknownCount: 0 }); return data.get(key)!; };
  for (const order of orders) {
    if (!order.paidAt || order.status !== 'paid') continue;
    const row = ensure(shanghaiDateKey(order.paidAt));
    if (order.paidAmountCents === null) row.unknownCount += 1; else row.paidCents += order.paidAmountCents;
  }
  for (const refund of refunds) {
    if (!refund.refundedAt || refund.status !== 'succeeded') continue;
    const row = ensure(shanghaiDateKey(refund.refundedAt));
    if (refund.amountCents === null) row.unknownCount += 1; else row.refundCents += refund.direction === 'refund' ? refund.amountCents : -refund.amountCents;
  }
  return [...data.values()].sort((a, b) => a.date.localeCompare(b.date)).map((row) => ({ ...row, paidYuan: row.paidCents / 100, refundYuan: row.refundCents / 100 }));
}

function buildRanking(orders: WorkspaceSnapshot['orders'], corrections: WorkspaceSnapshot['ownerCorrections'], members: WorkspaceSnapshot['members'], from: string, to: string) {
  const latestCorrection = new Map<string, { id: string; correctedMemberId: string | null; recordedAt: string }>();
  for (const correction of corrections) {
    const existing = latestCorrection.get(correction.orderLineId);
    const compareRecordedAt = existing ? compareTimestamps(correction.recordedAt, existing.recordedAt, 'desc') : -1;
    if (!existing || compareRecordedAt < 0 || (compareRecordedAt === 0 && existing.id < correction.id)) latestCorrection.set(correction.orderLineId, correction);
  }
  const sums = new Map<string, { name: string; paidCents: number; count: number; unknown: number }>();
  for (const order of orders) {
    if (order.status !== 'paid' || !order.paidAt) continue;
    const day = shanghaiDateKey(order.paidAt);
    if ((from && day < from) || (to && day > to)) continue;
    const memberId = latestCorrection.has(order.id) ? latestCorrection.get(order.id)?.correctedMemberId : order.ownerSnapshot.memberId;
    if (!memberId) continue;
    const member = members.find((item) => item.id === memberId);
    if (!member) continue;
    const record = sums.get(memberId) ?? { name: member.displayName, paidCents: 0, count: 0, unknown: 0 };
    record.count += 1;
    if (order.paidAmountCents === null) record.unknown += 1; else record.paidCents += order.paidAmountCents;
    sums.set(memberId, record);
  }
  const ranking = [...sums.values()].map((item) => ({ ...item, paidYuan: item.paidCents / 100, assigned: true })).sort((a, b) => b.paidCents - a.paidCents);
  return ranking;
}
