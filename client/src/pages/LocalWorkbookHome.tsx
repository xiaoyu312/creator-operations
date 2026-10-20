import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowRight, CalendarDays, Database, PackageCheck, Radio, RefreshCw } from 'lucide-react';
import type { LocalWorkbookActor, WorkbookPlatform, WorkbookSummary } from '@shared/workbook';
import { useWorkbench } from '../workbench-context';
import { Button } from '../components/ui/button';
import { EmptyState, PageHeading, formatDateTime } from '../components/workbench';
import { getWorkbookSummary } from '../lib/workbook-api';
import { getWorkbookContext, isBusinessWorkspace, workbookSummaryQueryKey, type WorkbookContext } from '../lib/workbook-context';
import { resolveWorkbookSourceMetadata, visibleWorkbookHistoryKinds, workbookHistoryHref } from '../lib/workbook-route';
import '../local-workbook-home.css';

const platformOrder: WorkbookPlatform[] = ['douyin', 'channels', 'xiaohongshu', 'kuaishou', 'unknown'];
const platformLabels: Record<WorkbookPlatform, string> = { douyin: '抖音', channels: '视频号', xiaohongshu: '小红书', kuaishou: '快手', unknown: '待核对' };

function compactCount(value: number) {
  return value.toLocaleString('zh-CN');
}

function barWidth(value: number, max: number) {
  return `${max > 0 ? Math.max(3, value / max * 100) : 0}%`;
}

function registeredPlatformCounts(summary: WorkbookSummary) {
  const counts = Object.fromEntries(platformOrder.map((platform) => [platform, 0])) as Record<WorkbookPlatform, number>;
  for (const item of summary.sourceStatusCounts) {
    if (item.kind === 'samples' || item.kind === 'broadcast') counts[item.platform] += item.count;
  }
  return counts;
}

type StatusGroup = { key: string; label: string; count: number };
function groupStatuses(summary: WorkbookSummary | undefined) {
  const grouped = new Map<string, StatusGroup>();
  for (const item of summary?.sourceStatusCounts ?? []) {
    if (item.kind !== 'samples' && item.kind !== 'broadcast') continue;
    const value = item.value === '__blank__' ? '未填写' : item.value;
    const key = `${item.kind}:${value}`;
    const kindLabel = item.kind === 'samples' ? '寄样' : '上播';
    const existing = grouped.get(key) ?? { key, label: `${kindLabel} · ${value}`, count: 0 };
    existing.count += item.count;
    grouped.set(key, existing);
  }
  const all = [...grouped.values()].sort((left, right) => right.count - left.count);
  const top = all.slice(0, 6);
  const rest = all.slice(6);
  const restCount = rest.reduce((total, item) => total + item.count, 0);
  if (restCount > 0) top.push({ key: 'other', label: `其余状态（${rest.length} 类）`, count: restCount });
  return top;
}

type OwnerGroup = { name: string; count: number; samples: number; broadcast: number };
function groupOwners(summary: WorkbookSummary | undefined) {
  const grouped = new Map<string, OwnerGroup>();
  for (const item of summary?.businessOwnerCounts ?? []) {
    const name = item.value === '__blank__' ? '未填写商务' : item.value;
    const existing = grouped.get(name) ?? { name, count: 0, samples: 0, broadcast: 0 };
    existing.count += item.count;
    if (item.kind === 'samples') existing.samples += item.count;
    if (item.kind === 'broadcast') existing.broadcast += item.count;
    grouped.set(name, existing);
  }
  return [...grouped.values()].sort((left, right) => right.count - left.count).slice(0, 6);
}

function LocalSourceLine({ label, fileName, readAt, year, years, onYearChange }: {
  label: string;
  fileName: string;
  readAt: string | null;
  year: number | null;
  years: number[];
  onYearChange: (value: string) => void;
}) {
  const yearValue = year === null ? 'all' : String(year);
  return <div className="local-workbook-source-line">
    <div className="local-workbook-source-identity">
      <span className="local-workbook-source-mark"><Database size={15} aria-hidden="true" /></span>
      <span><strong>{label}</strong><small>资料来源</small></span>
    </div>
    <label className="local-workbook-year-filter"><CalendarDays size={14} /><span>年份</span><select value={yearValue} onChange={(event) => onYearChange(event.target.value)} aria-label="选择年份">
      <option value="2026">2026 年</option>
      {[...new Set([2026, year ?? 2026, ...years])].filter((value) => value !== 2026).sort((left, right) => right - left).map((value) => <option key={value} value={value}>{value} 年</option>)}
      <option value="all">全部年份</option>
    </select></label>
    <details className="local-workbook-source-details">
      <summary>资料导入</summary>
      <div><b>资料文件</b><span>{fileName}</span><small>导入时间：{readAt ? formatDateTime(readAt) : '—'}</small></div>
    </details>
  </div>;
}

function ManagerAnalytics({ summary, platform, year, brandId, nativeHistory }: { summary: WorkbookSummary; platform: WorkbookPlatform | ''; year: number | null; brandId: string | null; nativeHistory: boolean }) {
  const platformCounts = registeredPlatformCounts(summary);
  const registeredRows = summary.kindCounts.samples + summary.kindCounts.broadcast;
  const platformMaximum = Math.max(...platformOrder.map((key) => platformCounts[key] ?? 0), 1);
  const statusGroups = useMemo(() => groupStatuses(summary), [summary]);
  const owners = useMemo(() => groupOwners(summary), [summary]);
  const ownerMaximum = Math.max(...owners.map((item) => item.count), 1);
  const monthlyCounts = [...summary.fillDateMonthlyCounts].sort((left, right) => left.month.localeCompare(right.month));
  const showFullMonthLabels = year === null || monthlyCounts.some((item) => item.month.slice(0, 4) !== String(year));
  const sampleHref = workbookHistoryHref({ nativeBusiness: nativeHistory, target: 'samples', platform, year, brandId });
  const broadcastHref = workbookHistoryHref({ nativeBusiness: nativeHistory, target: 'broadcast', platform, year, brandId });
  const sampleMissingHref = workbookHistoryHref({ nativeBusiness: nativeHistory, target: 'samples', platform, year, brandId, extra: { fieldState: 'tracking_missing' } });
  const broadcastMissingHref = workbookHistoryHref({ nativeBusiness: nativeHistory, target: 'broadcast', platform, year, brandId, extra: { fieldState: 'link_missing' } });
  const dataScreenHref = workbookHistoryHref({ nativeBusiness: nativeHistory, target: 'data-screen', platform, year, brandId });
  const sampleMissing = summary.operationalCounts.sampleTrackingMissing;
  const broadcastMissing = summary.operationalCounts.broadcastLinkMissing;

  const metricCards = [
    { label: '总登记', value: registeredRows, note: '进入完整分析', href: dataScreenHref, icon: <Database size={17} /> },
    { label: '寄样登记', value: summary.kindCounts.samples, note: '查看寄样队列', href: sampleHref, icon: <PackageCheck size={16} /> },
    { label: '上播登记', value: summary.kindCounts.broadcast, note: '查看上播设置', href: broadcastHref, icon: <Radio size={16} /> },
    { label: '待补物流', value: sampleMissing, note: '查看缺项记录', href: sampleMissingHref, icon: <PackageCheck size={16} /> },
    { label: '待补链接', value: broadcastMissing, note: '查看缺项记录', href: broadcastMissingHref, icon: <Radio size={16} /> },
  ];

  return <div className="local-manager-dashboard">
    <main className="local-manager-primary">
      <section className="local-manager-overview" aria-label="管理经营指标">
        <div className="local-manager-overview-heading">
          <div><span>经营概况</span><h2>登记与待处理项</h2></div>
          <span className="local-manager-scope">{platform ? platformLabels[platform] : '全部平台'}<i />{year === null ? '全部年份' : year + ' 年'}</span>
        </div>
        <div className="local-manager-kpi-grid">
          {metricCards.map((item, index) => <Link className={"local-manager-kpi-card" + (index === 0 ? ' is-primary' : '')} to={item.href} key={item.label}>
            <span className="local-manager-kpi-label">{item.label}</span>
            <span className="local-manager-kpi-icon">{item.icon}</span>
            <b>{compactCount(item.value)}</b>
            <small>{item.note}<ArrowRight size={13} /></small>
          </Link>)}
        </div>
      </section>

      <div className="local-manager-chart-grid">
        <section className="local-manager-panel local-manager-trend-panel">
          <div className="local-manager-panel-heading">
            <div><span>按填表日期统计</span><h2>填表月度分布</h2></div>
            <div className="local-manager-panel-links"><Link to={sampleHref}>寄样记录</Link><Link to={broadcastHref}>上播记录</Link></div>
          </div>
          {summary.fillDateCoverage.totalWithValidDate > 0 ? <>
            {monthlyCounts.length ? <div className={"local-manager-month-chart" + (showFullMonthLabels ? ' is-wide' : '')} role="img" aria-label={'填表月度分布：' + monthlyCounts.map((item) => item.month + ' ' + item.count + ' 条').join('，')} tabIndex={showFullMonthLabels ? 0 : undefined}>
              <div className="local-manager-month-chart-inner" style={showFullMonthLabels ? { minWidth: Math.max(720, monthlyCounts.length * 64) } : undefined}>
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={monthlyCounts} margin={{ top: 8, right: 12, left: 0, bottom: 2 }}>
                    <CartesianGrid stroke="#e9edf4" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="month" tick={{ fill: '#64748b', fontSize: 12 }} tickLine={false} axisLine={false} minTickGap={showFullMonthLabels ? 4 : 18} tickFormatter={(value) => showFullMonthLabels ? String(value) : Number(String(value).slice(5, 7)) + ' 月'} />
                    <YAxis width={46} allowDecimals={false} tick={{ fill: '#64748b', fontSize: 12 }} tickLine={false} axisLine={false} tickFormatter={(value) => compactCount(Number(value))} />
                    <Tooltip
                      formatter={(value) => [compactCount(typeof value === 'number' ? value : Number(value ?? 0)) + ' 条', '登记数']}
                      labelFormatter={(value) => String(value).slice(0, 4) + ' 年 ' + Number(String(value).slice(5, 7)) + ' 月'}
                      contentStyle={{ border: '1px solid #dce4ef', borderRadius: 8, boxShadow: '0 8px 24px rgb(18 39 72 / 12%)', fontSize: 13 }}
                      labelStyle={{ color: '#182334', fontWeight: 600 }}
                      itemStyle={{ color: '#2f66e9' }}
                    />
                    <Bar dataKey="count" name="登记数" fill="#2f66e9" radius={[4, 4, 0, 0]} maxBarSize={30} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div> : <p className="local-manager-empty">暂无填表日期。</p>}
            <small className="local-manager-panel-note">已按月归类 {compactCount(summary.fillDateCoverage.totalWithValidDate)} / {compactCount(summary.fillDateCoverage.rows)} 条；{summary.fillDateCoverage.missingOrInvalid > 0 ? compactCount(summary.fillDateCoverage.missingOrInvalid) + ' 条缺日期或无效，未纳入趋势。' : '本次筛选日期完整。'}</small>
          </> : <div className="local-manager-coverage-note">暂无填表日期。</div>}
        </section>

        <section className="local-manager-panel local-manager-platform-panel">
          <div className="local-manager-panel-heading">
          <div><span>按平台和年份</span><h2>寄样与上播记录</h2></div>
            <Link to={dataScreenHref}>完整分析<ArrowRight size={13} /></Link>
          </div>
          <div className="local-manager-platform-list">
            {platformOrder.map((key) => {
              const count = platformCounts[key] ?? 0;
              return <Link className={"local-manager-platform-row" + (platform === key ? ' is-current' : '')} to={workbookHistoryHref({ nativeBusiness: nativeHistory, target: 'home', platform: key, year, brandId })} key={key}>
                <span>{platformLabels[key]}</span><i><b style={{ width: barWidth(count, platformMaximum) }} /></i><strong>{compactCount(count)}</strong>
              </Link>;
            })}
          </div>
          <small className="local-manager-panel-note">按寄样与上播记录统计。</small>
        </section>
      </div>

      <section className="local-manager-panel local-manager-status-panel">
        <div className="local-manager-panel-heading">
          <div><span>高频前 6 类 + 其余</span><h2>登记状态分布</h2></div>
          <div className="local-manager-panel-links"><Link to={sampleHref}>寄样明细</Link><Link to={broadcastHref}>上播明细</Link></div>
        </div>
        {statusGroups.length ? <div className="local-manager-status-list">
          {statusGroups.map((item) => <div className="local-manager-status-row" key={item.key}>
            <span>{item.label}</span><strong>{compactCount(item.count)}</strong><i><b style={{ width: barWidth(item.count, Math.max(...statusGroups.map((group) => group.count), 1)) }} /></i>
          </div>)}
        </div> : <p className="local-manager-empty">没有符合条件的记录。</p>}
      </section>
    </main>

    <aside className="local-manager-sidebar">
      <section className="local-manager-panel local-manager-todo-panel">
        <div className="local-manager-panel-heading">
          <div><span>待补信息</span><h2>待处理</h2></div>
          <Link to={dataScreenHref}>查看<ArrowRight size={13} /></Link>
        </div>
        <Link to={sampleMissingHref}><span>寄样缺物流单号</span><b>{compactCount(sampleMissing)}</b><ArrowRight size={14} /></Link>
        <Link to={broadcastMissingHref}><span>上播缺链接 / 口令</span><b>{compactCount(broadcastMissing)}</b><ArrowRight size={14} /></Link>
        <Link to={workbookHistoryHref({ nativeBusiness: nativeHistory, target: 'home', platform: 'unknown', year, brandId })}><span>平台待核对</span><b>{compactCount(platformCounts.unknown)}</b><ArrowRight size={14} /></Link>
      </section>

      <section className="local-manager-panel local-manager-owner-panel">
        <div className="local-manager-panel-heading">
          <div><span>按商务名称排序</span><h2>商务登记数量</h2></div>
          <Link to={dataScreenHref}>明细<ArrowRight size={13} /></Link>
        </div>
        {owners.length ? <div className="local-manager-owner-list">
          {owners.map((item) => <div className="local-manager-owner-row" key={item.name}>
            <span className="local-manager-owner-avatar">{item.name.slice(0, 1)}</span>
            <span className="local-manager-owner-details"><b>{item.name}</b><i><span style={{ width: barWidth(item.count, ownerMaximum) }} /></i><small>寄样 {compactCount(item.samples)} · 上播 {compactCount(item.broadcast)}</small></span>
            <strong>{compactCount(item.count)}</strong>
          </div>)}
        </div> : <p className="local-manager-empty">当前筛选没有商务归属记录。</p>}
      </section>
    </aside>
  </div>;
}

function LocalRoleQueue({ role, summary, sampleHref, broadcastHref, countText }: {
  role: Exclude<LocalWorkbookActor['role'], 'local_manager'>;
  summary: WorkbookSummary | undefined;
  sampleHref: string;
  broadcastHref: string;
  countText: (value: number) => string;
}) {
  const isBd = role === 'local_bd';
  const isShipping = role === 'local_shipping';
  const isLinks = role === 'local_links';
  const title = isBd ? '登记寄样需求' : isShipping ? '打开寄样发货队列' : '打开上播设置队列';
  const subtitle = isBd ? '登记自有达人需求，并补充商品和收件资料。' : isShipping ? '查看寄样记录并处理发货信息。' : '维护直播产品、机制、佣金与链接设置。';
  const href = isLinks ? broadcastHref : sampleHref;
  const count = summary ? (isLinks ? summary.kindCounts.broadcast : summary.kindCounts.samples) : 0;
  const statusCount = summary ? (isLinks ? summary.operationalCounts.broadcastLinkMissing : summary.operationalCounts.sampleTrackingMissing) : 0;

  return <section className="local-role-queue-card">
    <div className="local-role-queue-icon">{isLinks ? <Radio size={21} /> : <PackageCheck size={21} />}</div>
    <div className="local-role-queue-copy"><span>{isLinks ? '上播设置队列' : '寄样工作队列'}</span><h2>{title}</h2><p>{subtitle}</p></div>
    <div className="local-role-queue-count"><b>{countText(count)}</b><span>条记录</span></div>
    <div className="local-role-queue-meta"><span>{isBd ? '自有寄样需求' : isLinks ? '缺上播链接 / 口令' : '缺物流单号'}</span><b>{countText(isBd ? (summary?.kindCounts.samples ?? 0) : statusCount)}</b></div>
    <Link className="local-role-queue-action" to={href}>{isBd ? '开始登记寄样需求' : isShipping ? '进入寄样发货' : '进入上播设置'}<ArrowRight size={16} /></Link>
    {isBd && <Link className="local-role-secondary-link" to={broadcastHref}>补充上播产品与设置资料</Link>}
  </section>;
}

export default function LocalWorkbookHome({ guide = false }: { guide?: boolean }) {
  const { session } = useWorkbench();
  const profile = useMemo(() => getWorkbookContext(session), [session]);
  if (!profile) return <EmptyState title="尚未选择品牌" description="请先选择品牌查看记录。" icon={<Database size={20} />} />;
  const nativeHistory = isBusinessWorkspace(session);
  const historyRole = session.businessWorkspace?.role ?? profile.role ?? 'local_manager';
  return <LocalWorkbookOverview profile={profile} guide={guide} nativeHistory={nativeHistory} historyRole={historyRole} />;
}

function LocalWorkbookOverview({ profile, guide, nativeHistory, historyRole }: { profile: WorkbookContext; guide: boolean; nativeHistory: boolean; historyRole: 'local_manager' | 'local_bd' | 'local_shipping' | 'local_links' | 'manager' | 'bd' | 'shipping' | 'links' }) {
  const role = profile.role ?? 'local_manager';
  const currentSourceSha = profile?.sourceSha256 ?? '';
  const cloud = profile.storage === 'cloud';
  const brandId = nativeHistory || cloud ? profile.brandId : null;
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedPlatform = searchParams.get('platform');
  const platform = (platformOrder.includes(requestedPlatform as WorkbookPlatform) ? requestedPlatform : '') as WorkbookPlatform | '';
  const requestedYear = searchParams.get('year');
  const year = requestedYear === 'all' ? null : /^\d{4}$/u.test(requestedYear ?? '') ? Number(requestedYear) : 2026;
  const catalogFilters = currentSourceSha ? { sourceSha256: currentSourceSha } : {};
  const catalogQuery = useQuery({
    queryKey: workbookSummaryQueryKey(profile, catalogFilters),
    queryFn: () => getWorkbookSummary(catalogFilters, profile),
    staleTime: 30_000,
  });
  const sources = useMemo(() => (catalogQuery.data?.sources ?? []).filter((source) => !currentSourceSha || source.sourceSha256 === currentSourceSha), [catalogQuery.data?.sources, currentSourceSha]);
  const years = useMemo(() => [...new Set(sources.flatMap((source) => source.sheets)
    .filter((sheet) => !sheet.hidden && (sheet.kind === 'samples' || sheet.kind === 'broadcast') && sheet.year !== null)
    .map((sheet) => sheet.year as number))], [sources]);
  const summaryFilters = {
    ...(currentSourceSha ? { sourceSha256: currentSourceSha } : {}),
    ...(platform ? { platform } : {}),
    ...(year ? { year } : {}),
  };
  const summaryQuery = useQuery({
    queryKey: workbookSummaryQueryKey(profile, summaryFilters),
    queryFn: () => getWorkbookSummary(summaryFilters, profile),
    staleTime: 30_000,
  });
  const summary = summaryQuery.data;
  const { sourceFileName, readAt: sourceReadAt } = resolveWorkbookSourceMetadata(profile, sources);
  const sourceLabel = profile.brandName || profile.label || '当前品牌';
  const countText = (value: number) => summaryQuery.isLoading ? '…' : summaryQuery.isError ? '—' : compactCount(value);
  const historyKinds = visibleWorkbookHistoryKinds(historyRole);
  const canOpenDataScreen = historyRole === 'local_manager' || historyRole === 'manager';
  const pageTitle = guide ? `${sourceLabel} 业务记录` : role === 'local_manager' ? `${sourceLabel} 经营总览` : role === 'local_bd' ? `${sourceLabel} 商务工作台` : role === 'local_shipping' ? `${sourceLabel} 寄样发货` : `${sourceLabel} 上播设置`;
  const pageDescription = guide ? '查看已登记的寄样和上播记录。'
    : role === 'local_manager' ? '按平台和年份查看记录与待补信息。'
      : role === 'local_bd' ? '登记自有达人寄样需求，并补充上播产品资料。'
        : role === 'local_shipping' ? '处理寄样记录；收件信息在对应详情中查看。'
          : '维护上播产品、机制、佣金与链接设置资料。';
  const sampleHref = workbookHistoryHref({ nativeBusiness: nativeHistory, target: 'samples', platform, year, brandId });
  const broadcastHref = workbookHistoryHref({ nativeBusiness: nativeHistory, target: 'broadcast', platform, year, brandId });
  const dataScreenHref = workbookHistoryHref({ nativeBusiness: nativeHistory, target: 'data-screen', platform, year, brandId });

  function changeYear(value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set('year', value); else next.delete('year');
    setSearchParams(next);
  }

  return <div className={`page-stack local-workbook-home${role === 'local_manager' && !guide ? ' local-manager-home' : ' local-role-home'}`}>
    <PageHeading title={pageTitle} description={pageDescription} actions={canOpenDataScreen ? <Link className="button button-outline local-data-screen-entry" to={dataScreenHref}><Database size={14} />历史资料大屏<ArrowRight size={14} /></Link> : undefined} />

    <LocalSourceLine label={sourceLabel} fileName={sourceFileName} readAt={sourceReadAt} year={year} years={years} onYearChange={changeYear} />

    {summaryQuery.isError && <div className="local-workbook-error" role="alert"><span>记录暂时无法加载。</span><Button variant="outline" size="sm" onClick={() => void summaryQuery.refetch()}><RefreshCw size={14} />重试</Button></div>}
    {summaryQuery.isLoading && <div className="local-workbook-loading" role="status">正在加载记录…</div>}
    {catalogQuery.data && sources.length === 0 && <EmptyState title="暂无寄样或上播记录" description="导入资料后，相关记录会显示在这里。" icon={<Database size={20} />} />}

    {guide && <section className="local-manager-panel" aria-label="历史业务记录">
      <div className="local-manager-panel-heading"><div><span>{platform ? platformLabels[platform] : '全部平台'} · {year === null ? '全部年份' : `${year} 年`}</span><h2>历史业务记录</h2></div><div className="local-manager-panel-links">
        {platform && <Link to={workbookHistoryHref({ nativeBusiness: nativeHistory, target: 'home', year, brandId })}>全部平台</Link>}
        {canOpenDataScreen && <Link to={dataScreenHref}>查看历史资料大屏<ArrowRight size={13} /></Link>}
      </div></div>
      <div className="local-manager-todo-panel">
        {historyKinds.map((kind) => {
          const label = kind === 'samples' ? '寄样历史' : '上播历史';
          const href = kind === 'samples' ? sampleHref : broadcastHref;
          const count = summary?.kindCounts[kind] ?? 0;
          return <Link to={href} key={kind}><span>{label}</span><b>{countText(count)} 条</b><ArrowRight size={15} /></Link>;
        })}
      </div>
    </section>}
    {!guide && role === 'local_manager' && summary && <ManagerAnalytics summary={summary} platform={platform} year={year} brandId={brandId} nativeHistory={nativeHistory} />}
    {!guide && role !== 'local_manager' && <LocalRoleQueue role={role} summary={summary} sampleHref={sampleHref} broadcastHref={broadcastHref} countText={countText} />}
  </div>;
}

export function LocalWorkbookUnavailable() {
  const { session } = useWorkbench();
  const workbook = getWorkbookContext(session);
  const brandName = workbook?.brandName ?? '品牌';
  return <div className="page-stack local-workbook-home local-workbook-unavailable">
    <PageHeading title="此页面暂不可用" description="请返回工作台继续操作。" />
    <div><Link className="button" to="/">返回{brandName}工作台<ArrowRight size={14} /></Link></div>
  </div>;
}
