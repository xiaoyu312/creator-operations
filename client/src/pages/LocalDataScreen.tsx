import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ArrowLeft, CalendarDays, Database, PackageCheck, Radio, RefreshCw } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import type { WorkbookPlatform, WorkbookSummary } from '@shared/workbook';
import { useWorkbench } from '../workbench-context';
import { Button } from '../components/ui/button';
import { EmptyState } from '../components/workbench';
import LocalPlatformTabs from '../components/LocalPlatformTabs';
import LocalRoleSwitcher from '../components/LocalRoleSwitcher';
import BrandSwitcher from '../components/BrandSwitcher';
import { getWorkbookSummary } from '../lib/workbook-api';
import { getWorkbookContext, isBusinessWorkspace, workbookSummaryQueryKey, type WorkbookContext } from '../lib/workbook-context';
import { workbookHistoryHref } from '../lib/workbook-route';
import '../local-data-screen.css';

const platformLabels: Record<WorkbookPlatform, string> = {
  douyin: '抖音',
  channels: '视频号',
  xiaohongshu: '小红书',
  kuaishou: '快手',
  unknown: '待核对',
};
const platformOrder: WorkbookPlatform[] = ['douyin', 'channels', 'xiaohongshu', 'kuaishou', 'unknown'];
const platformColors: Record<WorkbookPlatform, string> = {
  douyin: '#5B9BFA',
  channels: '#4CB6C7',
  xiaohongshu: '#9BC4FF',
  kuaishou: '#2E6BC4',
  unknown: '#899CB6',
};
const coordinationLabels = {
  unreviewed: '未复核',
  in_progress: '处理中',
  waiting: '等待补充',
  resolved: '已处理',
  on_hold: '暂缓',
} as const;

function compactCount(value: number) {
  return value.toLocaleString('zh-CN');
}

function safeRatio(value: number, total: number) {
  return total > 0 ? Math.max(0, Math.min(100, value / total * 100)) : 0;
}

function registeredPlatformCounts(summary: WorkbookSummary): Record<WorkbookPlatform, number> {
  const counts = Object.fromEntries(platformOrder.map((platform) => [platform, 0])) as Record<WorkbookPlatform, number>;
  for (const item of summary.sourceStatusCounts) {
    if (item.kind === 'samples' || item.kind === 'broadcast') counts[item.platform] += item.count;
  }
  return counts;
}

type OwnerRank = { name: string; count: number; samples: number; broadcast: number };
function ownerRanking(summary: WorkbookSummary): OwnerRank[] {
  const grouped = new Map<string, OwnerRank>();
  for (const item of summary.businessOwnerCounts) {
    if (item.kind !== 'samples' && item.kind !== 'broadcast') continue;
    const name = item.value === '__blank__' ? '未填写商务' : item.value.trim();
    const current = grouped.get(name) ?? { name, count: 0, samples: 0, broadcast: 0 };
    current.count += item.count;
    if (item.kind === 'samples') current.samples += item.count;
    if (item.kind === 'broadcast') current.broadcast += item.count;
    grouped.set(name, current);
  }
  const ranked = [...grouped.values()].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, 'zh-CN'));
  const top = ranked.slice(0, 6);
  const remainder = ranked.slice(6);
  if (remainder.length > 0) {
    top.push({
      name: `其余商务（${remainder.length} 人）`,
      count: remainder.reduce((total, item) => total + item.count, 0),
      samples: remainder.reduce((total, item) => total + item.samples, 0),
      broadcast: remainder.reduce((total, item) => total + item.broadcast, 0),
    });
  }
  return top;
}

function countTooltip(value: number | string | undefined) {
  return `${compactCount(Number(value ?? 0))} 条`;
}

export default function LocalDataScreen() {
  const { session } = useWorkbench();
  const workbook = useMemo(() => getWorkbookContext(session), [session]);
  if (!workbook) return <EmptyState title="尚未选择品牌" description="请先选择品牌查看数据。" />;
  return <WorkbookDataScreen workbook={workbook} nativeHistory={isBusinessWorkspace(session)} />;
}

function WorkbookDataScreen({ workbook, nativeHistory }: { workbook: WorkbookContext; nativeHistory: boolean }) {
  const currentSourceSha = workbook.sourceSha256 ?? '';
  const brandId = workbook.brandId ?? null;
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedPlatform = searchParams.get('platform');
  const platform = (platformOrder.includes(requestedPlatform as WorkbookPlatform) ? requestedPlatform : '') as WorkbookPlatform | '';
  const catalogFilters = currentSourceSha ? { sourceSha256: currentSourceSha } : {};
  const catalogQuery = useQuery({
    queryKey: workbookSummaryQueryKey(workbook, catalogFilters),
    queryFn: () => getWorkbookSummary(catalogFilters, workbook),
    enabled: Boolean(brandId || workbook.storage === 'local'),
    staleTime: 30_000,
  });
  const years = useMemo(() => [...new Set((catalogQuery.data?.sources ?? []).flatMap((source) => source.sheets)
    .filter((sheet) => !sheet.hidden && (sheet.kind === 'samples' || sheet.kind === 'broadcast') && sheet.year !== null)
    .map((sheet) => sheet.year as number))].sort((left, right) => right - left), [catalogQuery.data?.sources]);
  const requestedYear = searchParams.get('year');
  const parsedYear = Number(requestedYear);
  const year = requestedYear === 'all'
    ? null
    : Number.isInteger(parsedYear) && parsedYear >= 2000 && parsedYear <= 2100
      ? parsedYear
      : 2026;
  const yearLabel = year === null ? '全部年份' : `${year} 年`;
  const summaryFilters = { ...(currentSourceSha ? { sourceSha256: currentSourceSha } : {}), ...(year !== null ? { year } : {}), ...(platform ? { platform } : {}) };
  const scopedQuery = useQuery({
    queryKey: workbookSummaryQueryKey(workbook, summaryFilters),
    queryFn: () => getWorkbookSummary(summaryFilters, workbook),
    enabled: Boolean(brandId || workbook.storage === 'local'),
    staleTime: 30_000,
  });
  const platformScopeFilters = { ...(currentSourceSha ? { sourceSha256: currentSourceSha } : {}), ...(year !== null ? { year } : {}) };
  const platformScopeQuery = useQuery({
    queryKey: workbookSummaryQueryKey(workbook, platformScopeFilters),
    queryFn: () => getWorkbookSummary(platformScopeFilters, workbook),
    enabled: Boolean(brandId || workbook.storage === 'local'),
    staleTime: 30_000,
  });
  const summary = scopedQuery.data;
  const platformScopeCounts = platformScopeQuery.data ? registeredPlatformCounts(platformScopeQuery.data) : null;
  const unknownCount = platformScopeCounts?.unknown ?? 0;
  const platformCounts = summary ? registeredPlatformCounts(summary) : null;
  const registeredRows = summary ? summary.kindCounts.samples + summary.kindCounts.broadcast : 0;
  const owners = useMemo(() => summary ? ownerRanking(summary) : [], [summary]);
  const ownerMaximum = Math.max(...owners.map((item) => item.count), 1);
  const monthData = useMemo(() => [...(summary?.fillDateMonthlyCounts ?? [])].sort((left, right) => left.month.localeCompare(right.month)), [summary?.fillDateMonthlyCounts]);
  const showYearInMonthLabel = year === null || monthData.some((item) => item.month.slice(0, 4) !== String(year));
  const exitTo = workbookHistoryHref({ nativeBusiness: nativeHistory, target: 'home', platform, year, brandId });

  function updateFilter(value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set('year', value); else next.delete('year');
    setSearchParams(next);
  }

  const platformData = platformOrder.map((key) => ({ key, name: platformLabels[key], count: platformCounts?.[key] ?? 0 }));
  const pieData = platformData.filter((item) => item.count > 0);
  const sampleRows = summary?.operationalCounts.samplesRows ?? 0;
  const sampleMissing = summary?.operationalCounts.sampleTrackingMissing ?? 0;
  const broadcastRows = summary?.operationalCounts.broadcastRows ?? 0;
  const broadcastMissing = summary?.operationalCounts.broadcastLinkMissing ?? 0;
  const dateRows = summary?.fillDateCoverage.rows ?? 0;
  const validDates = summary?.fillDateCoverage.totalWithValidDate ?? 0;
  const missingDates = summary?.fillDateCoverage.missingOrInvalid ?? 0;

  return <div className="local-data-screen">
    <header className="local-data-screen-header">
      <Link className="local-data-screen-back" to={exitTo}><ArrowLeft size={17} /><span>返回工作台</span></Link>
      <div className="local-data-screen-title"><span className="local-data-screen-mark"><Database size={20} /></span><span><strong>{workbook.brandName} 经营数据</strong><small>寄样与上播记录</small></span></div>
      <div className="local-data-screen-actions"><BrandSwitcher /><LocalRoleSwitcher /><span className="local-data-screen-owner">{workbook.businessOwnerName ?? '管理视角'}</span></div>
    </header>

    <div className="local-data-screen-filters">
      <LocalPlatformTabs unknownCount={unknownCount} />
      <label className="local-data-year-filter"><CalendarDays size={16} /><span>年份</span><select value={year === null ? 'all' : year} onChange={(event) => updateFilter(event.target.value)} aria-label="选择年份">
        <option value="all">全部年份</option>
        {[...new Set([2026, year ?? 2026, ...years])].sort((left, right) => right - left).map((value) => <option key={value} value={value}>{value} 年</option>)}
      </select></label>
    </div>

    {scopedQuery.isLoading && <div className="local-data-screen-state" role="status">正在加载数据…</div>}
    {scopedQuery.isError && <div className="local-data-screen-error" role="alert"><span>数据暂时无法加载。</span><Button variant="outline" size="sm" onClick={() => void scopedQuery.refetch()}><RefreshCw size={14} />重试</Button></div>}

    {summary && <main className="local-data-screen-grid">
      <div className="local-data-column local-data-column-left">
        <section className="local-data-panel local-data-platform-panel">
          <div className="local-data-panel-heading"><div><span>{yearLabel} · 登记平台</span><h2>平台分布</h2></div><small>{compactCount(registeredRows)} 条</small></div>
          {registeredRows > 0 ? <div className="local-data-platform-content">
            <div className="local-data-donut-wrap" role="img" aria-label={`平台登记分布：${pieData.map((item) => `${item.name} ${compactCount(item.count)} 条`).join('，')}`}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={pieData} dataKey="count" nameKey="name" cx="50%" cy="50%" innerRadius="65%" outerRadius="90%" paddingAngle={2} stroke="none" isAnimationActive={false}>
                    {pieData.map((item) => <Cell key={item.key} fill={platformColors[item.key]} />)}
                  </Pie>
                  <Tooltip
                    formatter={(value) => [countTooltip(typeof value === 'number' || typeof value === 'string' ? value : undefined), '登记记录']}
                    contentStyle={{ backgroundColor: '#132541', border: '1px solid #2B4263', borderRadius: 8, color: '#ECF3FC', fontSize: 13 }}
                    labelStyle={{ color: '#C5D4E8', marginBottom: 4 }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="local-data-donut-center"><b>{compactCount(registeredRows)}</b><span>条登记</span></div>
            </div>
            <div className="local-data-platform-legend">
              {platformData.map((item) => <div className="local-data-platform-legend-row" key={item.key}>
                <i style={{ backgroundColor: platformColors[item.key] }} /><span>{item.name}</span><b>{compactCount(item.count)}</b>
              </div>)}
            </div>
          </div> : <EmptyState title="当前筛选没有登记记录" description="选择其他平台或年份查看记录。" />}
        </section>

        <section className="local-data-panel local-data-completeness-panel">
          <div className="local-data-panel-heading"><div><span>信息填写情况</span><h2>字段完整性</h2></div></div>
          <CompletenessRow label="物流单号" completed={Math.max(0, sampleRows - sampleMissing)} total={sampleRows} missing={sampleMissing} missingLabel="缺单号" />
          <CompletenessRow label="上播链接 / 口令" completed={Math.max(0, broadcastRows - broadcastMissing)} total={broadcastRows} missing={broadcastMissing} missingLabel="缺链接" />
          <CompletenessRow label="填表日期" completed={validDates} total={dateRows} missing={missingDates} missingLabel="缺日期" />
        </section>
      </div>

      <div className="local-data-column local-data-column-main">
        <section className="local-data-hero-card">
          <div className="local-data-hero-kicker">当前筛选登记记录 · {yearLabel}</div>
          <div className="local-data-hero-total"><strong>{compactCount(registeredRows)}</strong><span>条</span></div>
          <div className="local-data-hero-stats">
            <div><span><PackageCheck size={17} />寄样登记</span><b>{compactCount(summary.kindCounts.samples)}</b></div>
            <div><span><Radio size={17} />上播登记</span><b>{compactCount(summary.kindCounts.broadcast)}</b></div>
            <div><span><Database size={17} />补充记录</span><b>{compactCount(summary.totals.manualRows)}</b></div>
          </div>
        </section>

        <section className="local-data-panel local-data-trend-panel">
          <div className="local-data-panel-heading"><div><span>按填表日期统计</span><h2>填表月度趋势</h2></div><span className="local-data-trend-coverage">{compactCount(validDates)} / {compactCount(dateRows)} 条</span></div>
          {validDates > 0 && monthData.length > 0 ? <div className="local-data-trend-chart" role="img" aria-label={`填表月度登记趋势：${monthData.map((item) => `${item.month} ${compactCount(item.count)} 条`).join('，')}`}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={monthData} margin={{ top: 14, right: 14, left: -12, bottom: 2 }}>
                <CartesianGrid stroke="rgba(150, 176, 210, .12)" vertical={false} strokeDasharray="3 5" />
                <XAxis dataKey="month" tick={{ fill: '#AFC0D7', fontSize: 12 }} tickFormatter={(value) => showYearInMonthLabel ? String(value) : `${String(value).slice(5)} 月`} tickLine={false} axisLine={{ stroke: 'rgba(150, 176, 210, .18)' }} minTickGap={16} />
                <YAxis allowDecimals={false} tick={{ fill: '#AFC0D7', fontSize: 12 }} tickLine={false} axisLine={false} width={46} />
                <Tooltip
                  formatter={(value) => [countTooltip(typeof value === 'number' || typeof value === 'string' ? value : undefined), '登记记录']}
                  labelFormatter={(value) => `${String(value).slice(0, 4)} 年 ${String(value).slice(5)} 月`}
                  contentStyle={{ backgroundColor: '#132541', border: '1px solid #2B4263', borderRadius: 8, color: '#ECF3FC', fontSize: 13 }}
                  labelStyle={{ color: '#C5D4E8', marginBottom: 4 }}
                  cursor={{ stroke: 'rgba(164, 193, 231, .34)', strokeDasharray: '3 4' }}
                />
                <Area type="monotone" dataKey="count" name="登记记录" stroke="#6EA9FF" strokeWidth={3} fill="#397FE6" fillOpacity={0.16} activeDot={{ r: 5, stroke: '#DDEBFF', strokeWidth: 2 }} dot={{ r: 3, fill: '#8FC0FF', stroke: '#0E1C33', strokeWidth: 2 }} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div> : <div className="local-data-empty-trend"><EmptyState title="暂无填表日期" description="当前没有可展示的月度记录。" /></div>}
        </section>
      </div>

      <div className="local-data-column local-data-column-right">
        <section className="local-data-panel local-data-owner-panel">
          <div className="local-data-panel-heading"><div><span>按商务名称统计</span><h2>商务工作量</h2></div><small>前 6 名 + 其余</small></div>
          {owners.length > 0 ? <div className="local-data-owner-list">
            {owners.map((item, index) => <div className={`local-data-owner-row${item.name.startsWith('其余商务') ? ' is-other' : ''}`} key={`${item.name}-${index}`}>
              <span className="local-data-owner-rank">{item.name.startsWith('其余商务') ? '…' : String(index + 1).padStart(2, '0')}</span>
              <span className="local-data-owner-copy"><strong>{item.name}</strong><i><span style={{ width: `${safeRatio(item.count, ownerMaximum)}%` }} /></i><small>寄样 {compactCount(item.samples)} · 上播 {compactCount(item.broadcast)}</small></span>
              <b>{compactCount(item.count)}</b>
            </div>)}
          </div> : <EmptyState title="暂无商务名称记录" description="没有可展示的商务名称。" />}
        </section>

        <section className="local-data-panel local-data-coordination-panel">
          <div className="local-data-panel-heading"><div><span>当前记录</span><h2>协作状态</h2></div></div>
          <div className="local-data-coordination-list">
            {(Object.keys(coordinationLabels) as Array<keyof typeof coordinationLabels>).map((status) => <div className="local-data-coordination-row" key={status}><span>{coordinationLabels[status]}</span><b>{compactCount(summary.coordinationStatusCounts[status] ?? 0)}</b></div>)}
          </div>
        </section>
      </div>
    </main>}
  </div>;
}

function CompletenessRow({ label, completed, total, missing, missingLabel }: {
  label: string;
  completed: number;
  total: number;
  missing: number;
  missingLabel: string;
}) {
  const percent = safeRatio(completed, total);
  return <div className="local-data-completeness-row">
    <div className="local-data-completeness-top"><strong>{label}</strong><span>{compactCount(completed)} / {compactCount(total)}</span></div>
    <div className="local-data-completeness-track"><i style={{ width: `${percent}%` }} /></div>
    <small>{total > 0 ? `${missingLabel} ${compactCount(missing)} 条` : '当前筛选无对应记录'}</small>
  </div>;
}
