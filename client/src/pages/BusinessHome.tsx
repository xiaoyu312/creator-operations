import { useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlarmClock, ArrowRight, ArrowUpRight, CalendarClock, ClipboardCheck, Compass, Monitor, PackageCheck, PackageOpen, Plus, Truck, Video } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CRM_STAGES, type CrmStage } from '@shared/types';
import { useWorkbench } from '../workbench-context';
import { EmptyState, HelpTip, StatusPill, formatCompactMoney, formatDateTime, shanghaiDateKey } from '../components/workbench';
import { EmptyIllustration } from '../components/ProductVisuals';
import { homeApprovalListPath, selectActionableSamples } from '../lib/sample-queue';
import PlatformTabs from '../components/PlatformTabs';
import { useOnboardingGuide } from '../components/OnboardingGuide';
import { getBusinessOrderSourceStatus, buildBusinessHomeFacts, getBusinessHomeRankingAmount, type BusinessHomePlatform, type BusinessHomeRankingRow } from '../lib/business-home';
import { brandScopedHref, homeDateRange, type HomeDatePreset } from '../lib/home-actions';
import { getWorkbookContext } from '../lib/workbook-context';
import { HomeConversionFunnels } from '../components/HomeConversionFunnels';
import { buildHomeFunnels, stageTouchesFromProgress } from '../lib/home-funnel';
import { buildHomePeriodKpis, buildHomeTodoCounts, changeRatio, greetingFor, homeHeroSentence, homePaidAmountText, previousRange, type ChangeRatio } from '../lib/home-insights';
import { platformLabel, isPlatform } from '../lib/platform-presentation';
import { compareTimestamps } from '../lib/time';
import { buildHomeProductRanking } from '../lib/home-overview';
import '../business-home.css';

const stageLabels: Record<CrmStage, string> = {
  uncontacted: '未建联',
  contacted: '已触达',
  responded: '有回应',
  negotiating: '洽谈中',
  cooperating: '合作中',
  paused: '暂停',
  declined: '不合作',
};
const funnelStages: CrmStage[] = ['uncontacted', 'contacted', 'responded', 'negotiating', 'cooperating', 'paused', 'declined'];

function todayKey() {
  return shanghaiDateKey(new Date());
}

function monthStart() {
  return `${todayKey().slice(0, 7)}-01`;
}

interface TodoCard {
  id: string;
  label: string;
  count: number;
  href: string;
  icon: ReactNode;
  tone: 'blue' | 'orange' | 'red' | 'green';
}

export default function BusinessHome() {
  const { workspace, session } = useWorkbench();
  const guide = useOnboardingGuide();
  const [searchParams, setSearchParams] = useSearchParams();
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(todayKey);
  const actor = session.actor;
  const brandId = session.businessWorkspace?.brandId ?? session.workbook?.brandId ?? searchParams.get('brandId') ?? undefined;
  const platformValue = searchParams.get('platform');
  const platform: BusinessHomePlatform = platformValue && isPlatform(platformValue) ? platformValue : 'all';
  const isOps = actor.role === 'ops';
  const isManager = actor.role === 'admin' || actor.role === 'manager';
  const workbookContext = getWorkbookContext(session);
  const historyRole = session.businessWorkspace?.role ?? workbookContext?.role;
  const canOpenDataScreen = workbookContext?.role === 'local_manager' && (historyRole === 'local_manager' || historyRole === 'manager');
  const canSeeOrders = !isOps;
  const today = todayKey();
  const href = (path: string) => brandScopedHref(path, brandId);
  const dataScreenHref = href('/source-records/data-screen');
  const scope = { role: actor.role, memberId: actor.memberId };

  const todos = useMemo(() => buildHomeTodoCounts(workspace, scope), [workspace, actor.role, actor.memberId]);
  const canApproveSamples = actor.capabilities.includes('sample.approve');
  const approvalCard: TodoCard = { id: 'approval', label: actor.role === 'bd' ? '寄样正在等运营审核' : '寄样待审核', count: todos.pendingApproval, href: href(homeApprovalListPath(canApproveSamples)), icon: <ClipboardCheck size={18} />, tone: 'blue' };
  const shipmentCard: TodoCard = { id: 'shipment', label: actor.role === 'bd' ? '样品正在等运营发货' : '样品待发货', count: todos.pendingShipment, href: href('/samples?queue=shipment'), icon: <PackageOpen size={18} />, tone: 'orange' };
  const receiptCard: TodoCard = { id: 'receipt', label: '样品待签收', count: todos.awaitingReceipt, href: href('/samples?queue=receipt'), icon: <Truck size={18} />, tone: 'blue' };
  const upcomingScheduleCount = workspace.schedules.filter((item) => !isOps && ['planned', 'rescheduled'].includes(item.status) && (actor.role !== 'bd' || item.ownerMemberId === actor.memberId) && Date.parse(item.plannedEndAt) >= Date.now()).length;
  const todoCards: TodoCard[] = actor.role === 'bd'
    ? [
        ...(todos.pendingApproval > 0 ? [approvalCard] : []),
        ...(todos.pendingShipment > 0 ? [shipmentCard] : []),
        receiptCard,
        ...(todos.pendingDelivery > 0 ? [{ id: 'delivery', label: '内容待交付', count: todos.pendingDelivery, href: href('/cooperations?status=pending_delivery'), icon: <Video size={18} />, tone: 'green' as const }] : []),
        { id: 'overdue', label: '逾期跟进', count: todos.overdueTasks, href: href('/tasks'), icon: <AlarmClock size={18} />, tone: 'red' },
        { id: 'schedule', label: '即将排期', count: upcomingScheduleCount, href: href('/schedule'), icon: <CalendarClock size={18} />, tone: 'green' },
      ]
    : [
        ...(isOps && !canApproveSamples ? [] : [approvalCard]),
        shipmentCard,
        receiptCard,
        ...(isOps ? [] : [
          { id: 'delivery', label: '内容待交付', count: todos.pendingDelivery, href: href('/cooperations?status=pending_delivery'), icon: <Video size={18} />, tone: 'green' as const },
          { id: 'overdue', label: '逾期跟进', count: todos.overdueTasks, href: href('/tasks'), icon: <AlarmClock size={18} />, tone: 'red' as const },
        ]),
      ];
  const orderStatus = useMemo(() => getBusinessOrderSourceStatus({
    orders: workspace.orders,
    importBatches: workspace.importBatches,
    importHistoryVisible: workspace.metrics.dataCoverage.importHistoryVisible,
  }), [workspace.orders, workspace.importBatches, workspace.metrics.dataCoverage.importHistoryVisible]);
  const facts = useMemo(() => buildBusinessHomeFacts({
    orders: workspace.orders,
    refunds: workspace.refunds,
    creators: workspace.creators,
    teams: workspace.teams,
    orderStatus,
    refundStatus: workspace.metrics.dataCoverage.refundDataStatus,
    observedAt: workspace.metrics.observedAt,
    filters: { from, to, platform },
  }), [workspace.orders, workspace.refunds, workspace.creators, workspace.teams, orderStatus, workspace.metrics.dataCoverage.refundDataStatus, workspace.metrics.observedAt, from, to, platform]);
  const current = useMemo(() => buildHomePeriodKpis(workspace, scope, { from, to }, platform), [workspace, actor.role, actor.memberId, from, to, platform]);
  const previous = useMemo(() => {
    const range = previousRange({ from, to });
    return range ? buildHomePeriodKpis(workspace, scope, range, platform) : null;
  }, [workspace, actor.role, actor.memberId, from, to, platform]);
  const productRanking = useMemo(() => buildHomeProductRanking(facts.orders, workspace.products), [facts.orders, workspace.products]);
  const funnels = useMemo(() => buildHomeFunnels({
    scope: { role: actor.role, memberId: actor.memberId, teamIds: workspace.scope.teamIds },
    range: { from, to },
    platform,
    observedAt: workspace.metrics.observedAt,
  }, {
    creators: workspace.creators,
    followups: workspace.followups,
    auditEvents: workspace.auditEvents,
    stageTouches: stageTouchesFromProgress(workspace.businessProgress),
    samples: workspace.samples,
    samplePackages: workspace.samplePackages,
    deliveries: workspace.deliveries,
    orders: workspace.orders,
    ownerCorrections: workspace.ownerCorrections,
  }), [workspace, actor.role, actor.memberId, from, to, platform]);

  const stageCreators = useMemo(() => {
    if (isOps) return [];
    if (actor.role === 'bd') return workspace.creators.filter((creator) => creator.ownerMemberId === actor.memberId);
    return workspace.creators.filter((creator) => workspace.scope.teamIds.includes(creator.teamId) && creator.ownerMemberId !== null);
  }, [workspace.creators, workspace.scope.teamIds, actor.role, actor.memberId, isOps]);
  const stageCounts = useMemo(() => CRM_STAGES.reduce((counts, stage) => ({ ...counts, [stage]: stageCreators.filter((creator) => creator.crmStage === stage).length }), {} as Record<CrmStage, number>), [stageCreators]);

  const schedules = useMemo(() => workspace.schedules.filter((item) =>
    !isOps && ['planned', 'rescheduled'].includes(item.status) && (actor.role !== 'bd' || item.ownerMemberId === actor.memberId) && Date.parse(item.plannedEndAt) >= Date.now(),
  ).sort((left, right) => compareTimestamps(left.plannedStartAt, right.plannedStartAt)).slice(0, 4), [workspace.schedules, isOps, actor.role, actor.memberId]);

  const opsQueue = useMemo(() => isOps ? selectActionableSamples({
    samples: workspace.samples,
    creators: workspace.creators,
    samplePackages: workspace.samplePackages,
    actor,
  }).slice(0, 8) : [], [isOps, workspace.samples, workspace.creators, workspace.samplePackages, actor]);
  const chartData = useMemo(() => facts.trend.map((point) => ({ date: point.date, paidYuan: point.paidCents / 100 })), [facts.trend]);
  const hasOrderSource = orderStatus === 'records_only';
  const refundsVisible = workspace.metrics.dataCoverage.refundDataStatus === 'records_only';

  function onPlatformChange(nextPlatform: BusinessHomePlatform) {
    const next = new URLSearchParams(searchParams);
    if (brandId) next.set('brandId', brandId);
    if (nextPlatform === 'all') next.delete('platform');
    else next.set('platform', nextPlatform);
    setSearchParams(next, { replace: true });
  }

  function choosePreset(preset: HomeDatePreset) {
    const range = homeDateRange(preset, today);
    setFrom(range.from);
    setTo(range.to);
  }

  const ordersHref = (tab?: 'refunds') => {
    const params = new URLSearchParams({ dateFrom: from, dateTo: to });
    if (platform !== 'all') params.set('platform', platform);
    if (tab) params.set('tab', tab);
    return href(`/orders?${params}`);
  };
  const creatorsHref = (stage?: CrmStage) => {
    const params = new URLSearchParams({ scope: isManager ? 'team' : 'mine', platform: 'all' });
    if (stage) params.set('stage', stage);
    return href(`/creators?${params}`);
  };

  const canImport = actor.capabilities.includes('import.manage');
  const activeProgressStages: CrmStage[] = ['uncontacted', 'contacted', 'responded', 'negotiating', 'cooperating'];
  const activeProgressTotal = activeProgressStages.reduce((sum, stage) => sum + (stageCounts[stage] ?? 0), 0);
  const progressStages = activeProgressTotal === 0 && ((stageCounts.paused ?? 0) + (stageCounts.declined ?? 0)) > 0
    ? (['paused', 'declined'] as CrmStage[])
    : funnelStages;
  const funnelMax = Math.max(1, ...progressStages.map((item) => stageCounts[item] ?? 0));
  const funnelCard = <section className="home-card home-funnel" aria-labelledby="home-funnel-title">
    <div className="home-card-head"><h3 id="home-funnel-title">达人进展 <small className="home-card-scope">全部平台</small></h3><Link to={creatorsHref()}>全部达人<ArrowUpRight size={13} /></Link></div>
    {stageCreators.length > 0 ? <ol className="home-funnel-list">
      {progressStages.map((stage) => {
        const count = stageCounts[stage] ?? 0;
        return <li key={stage}><Link to={creatorsHref(stage)}>
          <span className="home-funnel-label">{stageLabels[stage]}</span>
          <span className="home-funnel-bar"><span style={{ width: `${count ? Math.max(6, count / funnelMax * 100) : 0}%` }} /></span>
          <strong>{count}</strong>
        </Link></li>;
      })}
    </ol> : <p className="home-card-empty">还没有达人记录</p>}
  </section>;
  const scheduleCard = <section className="home-card" aria-labelledby="home-schedule-title">
    <div className="home-card-head"><h3 id="home-schedule-title">即将直播 <small className="home-card-scope">全部平台</small></h3><Link to={href('/schedule')}>排期<ArrowUpRight size={13} /></Link></div>
    {schedules.length ? <ul className="home-schedule-list">{schedules.map((schedule) => {
      const creator = workspace.creators.find((item) => item.id === schedule.creatorId);
      const account = creator?.accounts.find((item) => item.platform === schedule.platform);
      return <li key={schedule.id}><Link to={href(`/schedule?scheduleId=${encodeURIComponent(schedule.id)}`)}>
        <CalendarClock size={15} aria-hidden="true" />
        <span><strong>{account?.displayName ?? creator?.name ?? '达人'}</strong><small>{platformLabel(schedule.platform)}</small></span>
        <time>{formatDateTime(schedule.plannedStartAt)}</time>
      </Link></li>;
    })}</ul> : <p className="home-card-empty">近期没有直播安排</p>}
  </section>;

  const nextTask = guide?.plan.nextTask ?? null;
  const showGuideCard = Boolean(guide && nextTask);
  const nonDraftSampleCount = workspace.samples.filter((sample) => sample.status !== 'draft').length;
  const hasBusinessActivity = workspace.creators.length > 0
    || nonDraftSampleCount > 0
    || workspace.followups.length > 0
    || workspace.creatorSessions.length > 0
    || workspace.salesReports.length > 0
    || workspace.cooperations.length > 0
    || workspace.schedules.length > 0
    || workspace.deliveries.length > 0
    || workspace.samplePackages.length > 0
    || workspace.orders.length > 0;
  const showNoBusinessOnboarding = !hasBusinessActivity && Boolean(guide && nextTask);
  const visibleTodoCards = showNoBusinessOnboarding ? [] : todoCards;
  const heroSentence = showNoBusinessOnboarding
    ? '按下面的步骤开始使用工作台。'
    : homeHeroSentence({ firstSetup: false, nextTaskTitle: nextTask?.title ?? null, cards: visibleTodoCards });
  const onboardingFlow = isOps
    ? ['收到寄样申请', '完成审核', '登记发货', '确认签收']
    : actor.role === 'bd'
    ? ['添加达人', '申请寄样', '安排直播', '查看业绩']
    : ['录入商品与店铺', '添加并分配达人', '申请寄样', '安排合作 / 查看业绩'];
  const onboardingProgress = guide
    ? Math.round(guide.plan.doneCount / Math.max(1, guide.plan.totalCount) * 100)
    : 0;
  const paidAmountText = homePaidAmountText(current);

  return <div className="page-stack business-home-page home-simple">
    <header className="home-hero">
      <div className="home-hero-copy">
        <h1>{greetingFor()}，{actor.displayName}</h1>
        <p>{heroSentence}</p>
      </div>
      {(canOpenDataScreen || !showNoBusinessOnboarding) && <div className="home-hero-actions">
        {canOpenDataScreen && <Link className="button home-data-screen-entry" to={dataScreenHref}><Monitor size={16} aria-hidden="true" />数据大屏</Link>}
        {!showNoBusinessOnboarding && (isOps
          ? <Link className="button" to={href('/samples?queue=todo')}><PackageCheck size={15} />处理寄样</Link>
          : <>
            <Link className="button button-outline" to={href('/creators?create=1')}><Plus size={15} />新建达人</Link>
            <Link className="button" to={href('/samples?create=1')}><PackageCheck size={15} />申请寄样</Link>
          </>)}
      </div>}
    </header>

    {showNoBusinessOnboarding && guide && nextTask ? <>
      <section className="home-start-panel" aria-labelledby="home-start-title">
        <div className="home-start-artwork" aria-hidden="true">
          <EmptyIllustration kind={nextTask.id === 'mgr-products' ? 'products' : 'creators'} />
        </div>
        <div className="home-start-content">
          <div className="home-start-progress" role="group" aria-label={`上手进度 ${guide.plan.doneCount}/${guide.plan.totalCount}`}>
            <div className="home-start-progress-label"><span>上手进度</span><strong>{guide.plan.doneCount}/{guide.plan.totalCount}</strong></div>
            <div className="home-start-progress-track" aria-hidden="true"><span style={{ width: `${onboardingProgress}%` }} /></div>
          </div>
          <div className="home-start-copy">
            <h2 id="home-start-title">{nextTask.title}</h2>
            <p>{nextTask.description}</p>
          </div>
          <Link className="button home-start-cta" to={nextTask.href}>{nextTask.ctaLabel}<ArrowRight size={15} /></Link>
        </div>
      </section>
      <section className="home-start-flow" aria-labelledby="home-start-flow-title">
        <h2 id="home-start-flow-title">后续流程</h2>
        <ol>{onboardingFlow.map((step, index) => <li key={step}>
          <span className="home-start-flow-number" aria-hidden="true">{index + 1}</span>
          <span>{step}</span>
        </li>)}</ol>
      </section>
      <div className="home-start-history">
        <Link to={href('/source-records')}>查看历史资料<ArrowRight size={13} /></Link>
        <span>历史资料保留过去的记录；在工作台登记和跟进新的合作。</span>
      </div>
    </> : showGuideCard && guide && nextTask && <section className="home-guide-card" aria-label="上手进度">
      <span className="home-guide-icon"><Compass size={18} aria-hidden="true" /></span>
      <div className="home-guide-copy">
        <strong>上手进度 {guide.plan.doneCount}/{guide.plan.totalCount}</strong>
        <span>下一步：{nextTask.title}</span>
      </div>
      <div className="home-guide-track" aria-hidden="true"><span style={{ width: `${onboardingProgress}%` }} /></div>
      <Link className="button home-guide-cta" to={nextTask.href}>{nextTask.ctaLabel}<ArrowRight size={14} /></Link>
      <button type="button" className="home-guide-more" onClick={guide.open}>全部任务</button>
    </section>}

    {visibleTodoCards.length > 0 && <section className="home-section" aria-labelledby="home-todo-title">
      <h2 className="home-section-title" id="home-todo-title">今天要做的事</h2>
      <div className="home-todo-grid">
        {visibleTodoCards.map((card) => <Link key={card.id} to={card.href} className={`home-todo-card tone-${card.tone}${card.count === 0 ? ' is-empty' : ''}`}>
          <span className="home-todo-icon">{card.icon}</span>
          <span className="home-todo-label">{card.label}</span>
          <strong className="home-todo-count">{card.count}</strong>
        </Link>)}
      </div>
    </section>}

    {isOps && !showNoBusinessOnboarding && <section className="home-card" aria-labelledby="home-ops-queue-title">
      <div className="home-card-head"><h3 id="home-ops-queue-title">待处理寄样</h3><Link to={href('/samples?queue=todo')}>全部<ArrowUpRight size={13} /></Link></div>
      {opsQueue.length ? <ul className="home-schedule-list">{opsQueue.map((sample) => {
        const creator = workspace.creators.find((item) => item.id === sample.creatorId);
        const name = creator?.accounts.find((account) => account.id === sample.creatorAccountId)?.displayName ?? creator?.name ?? (sample.recipient?.recipientName || '寄样申请');
        const products = sample.lines.map((line) => workspace.products.find((product) => product.id === line.productId)?.name).filter(Boolean);
        const awaitingReceipt = sample.status === 'shipped';
        return <li key={sample.id}><Link to={href(`/samples?queue=${awaitingReceipt ? 'receipt' : sample.status === 'pending_approval' ? 'approval' : 'shipment'}`)}>
          <PackageCheck size={15} aria-hidden="true" />
          <span><strong>{name}</strong><small>{products.length ? products.join('、') : `${sample.lines.length} 个商品`} · {formatDateTime(sample.createdAt)}</small></span>
          <StatusPill value={awaitingReceipt ? 'pending' : sample.status} label={awaitingReceipt ? '待签收' : undefined} />
        </Link></li>;
      })}</ul> : <p className="home-card-empty">没有待处理的寄样</p>}
    </section>}

    {canSeeOrders && !showNoBusinessOnboarding && <section className="home-section home-performance" aria-labelledby="home-performance-title">
      <div className="home-section-head">
        <div className="home-section-title-row">
          <h2 className="home-section-title" id="home-performance-title">业绩怎么样</h2>
        </div>
        <div className="home-period">
          <PlatformTabs value={platform} onChange={onPlatformChange} allowAll variant="segment" label="按平台查看业绩" />
          <div className="home-presets" role="group" aria-label="统计周期">
            {([['today', '今日'], ['last7', '近 7 天'], ['month', '本月']] as Array<[HomeDatePreset, string]>).map(([preset, label]) => {
              const range = homeDateRange(preset, today);
              return <button key={preset} type="button" aria-pressed={from === range.from && to === range.to} onClick={() => choosePreset(preset)}>{label}</button>;
            })}
          </div>
        </div>
      </div>
      {hasOrderSource ? <div className="home-kpi-grid">
        <KpiCard label="成交金额" value={paidAmountText ?? formatCompactMoney(current.paidCents)} change={paidAmountText ? null : (previous ? changeRatio(current.paidCents, previous.paidCents) : null)} note={current.paidUnknownCount ? `含 ${current.paidUnknownCount} 笔金额未知` : undefined} href={ordersHref()} />
        <KpiCard label="订单数" value={current.paidCount.toLocaleString('zh-CN')} change={previous ? changeRatio(current.paidCount, previous.paidCount) : null} href={ordersHref()} />
        <KpiCard label="出单达人" value={current.sellingCreators.toLocaleString('zh-CN')} change={previous ? changeRatio(current.sellingCreators, previous.sellingCreators) : null} href={creatorsHref()} />
        <KpiCard label="退款金额" value={refundsVisible ? formatCompactMoney(current.refundCents) : '未导入'} change={refundsVisible && previous ? changeRatio(current.refundCents, previous.refundCents) : null} invert href={ordersHref('refunds')} />
      </div> : <div className="home-empty-card">
        <div className={`home-order-empty${canImport ? '' : ' is-readonly'}`}>
          <span className="home-order-empty-illustration"><EmptyIllustration kind="orders" /></span>
          <div className="home-order-empty-copy">
            <strong>还没有订单数据</strong>
            <p>{canImport ? '导入平台订单后，这里会显示成交金额、订单数和出单达人。' : '管理员导入订单后，这里会显示你名下达人的成交。'}</p>
          </div>
          {canImport && <Link className="button" to={href('/orders')}>导入订单</Link>}
        </div>
      </div>}
    </section>}

    {!showNoBusinessOnboarding && <HomeConversionFunnels funnels={funnels} periodLabel={`${from} 至 ${to}`} role={actor.role} />}

    {canSeeOrders && !showNoBusinessOnboarding && !hasOrderSource && <div className="home-detail-grid home-detail-grid--even">
      {funnelCard}
      {scheduleCard}
    </div>}

    {canSeeOrders && hasOrderSource && <div className="home-detail-grid">
      <section className="home-card home-trend" aria-labelledby="home-trend-title">
        <div className="home-card-head"><h3 id="home-trend-title">成交趋势</h3><Link to={ordersHref()}>订单明细<ArrowUpRight size={13} /></Link></div>
        {chartData.length ? <div className="home-chart" role="img" aria-label="成交金额趋势">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <defs><linearGradient id="homePaidFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#2f62e8" stopOpacity={0.18} /><stop offset="100%" stopColor="#2f62e8" stopOpacity={0} /></linearGradient></defs>
              <CartesianGrid stroke="#eef1f6" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: '#627085', fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={24} tickFormatter={(value) => String(value).slice(5)} />
              <YAxis tick={{ fill: '#627085', fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(value) => formatAxisYuan(Number(value))} width={52} />
              <Tooltip formatter={(value) => [formatYuan(Number(value)), '成交金额']} labelFormatter={(value) => String(value)} />
              <Area isAnimationActive={false} type="monotone" dataKey="paidYuan" stroke="#2f62e8" strokeWidth={2} fill="url(#homePaidFill)" />
            </AreaChart>
          </ResponsiveContainer>
        </div> : <EmptyState title="这段时间没有成交" description="换个时间范围看看。" />}
      </section>
      {funnelCard}
    </div>}

    {canSeeOrders && hasOrderSource && <div className="home-detail-grid home-detail-grid--three">
      <RankingCard title="达人成交榜" rows={facts.creatorRanking} empty="这段时间暂无达人成交" />
      <RankingCard title="商品成交榜" rows={productRanking.rows} empty="这段时间暂无商品成交" />
      {scheduleCard}
    </div>}
  </div>;
}

function KpiCard({ label, value, change, note, href, primary = false, invert = false }: {
  label: string;
  value: string;
  change: ChangeRatio | null;
  note?: string;
  href: string;
  primary?: boolean;
  invert?: boolean;
}) {
  return <Link to={href} className={`home-kpi${primary ? ' is-primary' : ''}`}>
    <span className="home-kpi-label">{label}</span>
    <strong className="home-kpi-value">{value}</strong>
    <span className="home-kpi-foot">
      {change && <ChangeBadge change={change} invert={invert} />}
      {note && <span className="home-kpi-note">{note}<HelpTip text="部分订单缺少金额，成交金额只统计已知金额。" /></span>}
    </span>
  </Link>;
}

function ChangeBadge({ change, invert }: { change: ChangeRatio; invert: boolean }) {
  if (change.kind === 'none') return <span className="home-change is-flat">较上期 持平</span>;
  if (change.kind === 'new') return <span className="home-change is-up">较上期 新增</span>;
  const up = change.value >= 0;
  const good = invert ? !up : up;
  const pct = Math.abs(change.value * 100);
  return <span className={`home-change ${good ? 'is-up' : 'is-down'}`}>较上期 {up ? '↑' : '↓'}{pct >= 100 ? Math.round(pct) : pct.toFixed(1)}%</span>;
}

function RankingCard({ title, rows, empty }: { title: string; rows: BusinessHomeRankingRow[]; empty: string }) {
  const visible = rows.slice(0, 5);
  return <section className="home-card">
    <div className="home-card-head"><h3>{title}</h3></div>
    {visible.length ? <ol className="home-rank-list">{visible.map((row, index) => {
      const amount = getBusinessHomeRankingAmount(row);
      return <li key={row.id}>
        <span className={`home-rank-index${index < 3 ? ' is-top' : ''}`}>{index + 1}</span>
        <span className="home-rank-name">{row.name}</span>
        <strong>{amount.status === 'missing' ? '金额未知' : formatCompactMoney(amount.knownCents)}</strong>
      </li>;
    })}</ol> : <p className="home-card-empty">{empty}</p>}
  </section>;
}

function formatYuan(value: number) {
  return `¥${new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;
}

function formatAxisYuan(value: number) {
  const amount = Math.round(value);
  if (Math.abs(amount) >= 10_000) return `${(amount / 10_000).toFixed(1)}万`;
  return amount.toLocaleString('zh-CN');
}
