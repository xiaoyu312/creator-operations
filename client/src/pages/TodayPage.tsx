import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { AlertTriangle, ArrowRight, CalendarCheck2, Check, Clock3, PackageCheck, Users } from 'lucide-react';
import type { WorkTask } from '@shared/types';
import { useWorkbench } from '../workbench-context';
import { useWalkthrough } from '../walkthrough-context';
import { Button } from '../components/ui/button';
import { EmptyState, MetricTile, PageHeading, Panel, StatusPill, formatDateTime, shanghaiDateKey } from '../components/workbench';
import { selectDailyStartingPoint, selectDemoWalkthrough } from '../lib/presentation';
import { compareTimestamps } from '../lib/time';
import '../onboarding.css';
import '../business-surfaces.css';

const kindLabels: Record<WorkTask['kind'], string> = {
  followup: '达人跟进', sample_approval: '样品审批', sample_shipment: '样品发货', sample_receipt: '签收确认',
  cooperation_approval: '合作审批', schedule: '直播排期', delivery_review: '交付验收', other: '其他任务',
};
const capabilityLabels: Record<string, string> = { 'sample.approve': '样品审批队列', 'sample.fulfill': '样品履约队列', 'cooperation.approve': '合作审批队列' };

export default function TodayPage({ tasksOnly = false }: { tasksOnly?: boolean }) {
  const { workspace, session, run, running } = useWorkbench();
  const { start } = useWalkthrough();
  const [showCompleted, setShowCompleted] = useState(false);
  const [kindFilter, setKindFilter] = useState('all');
  const today = shanghaiDateKey(new Date());
  const isManager = session.actor.role === 'manager' || session.actor.role === 'admin';
  const isOps = session.actor.role === 'ops';
  const scopedTasks = useMemo(() => workspace.tasks.filter((task) => {
    if (!workspace.scope.teamIds.includes(task.teamId)) return false;
    if (isManager) return true;
    if (session.actor.role === 'bd') return task.ownerMemberId === session.actor.memberId;
    return task.ownerMemberId === session.actor.memberId || Boolean(task.requiredCapability && session.actor.capabilities.includes(task.requiredCapability));
  }), [workspace.tasks, workspace.scope.teamIds, session.actor.memberId, session.actor.role, session.actor.capabilities, isManager]);
  const tasks = useMemo(() => scopedTasks.filter((task) => {
    if (!showCompleted && task.status !== 'open') return false;
    if (showCompleted && task.status === 'cancelled') return false;
    if (kindFilter !== 'all' && task.kind !== kindFilter) return false;
    return true;
  }).sort((a, b) => {
    const priority = { high: 0, normal: 1, low: 2 };
    const overdueA = a.status === 'open' && a.dueAt && Date.parse(a.dueAt) < Date.now() ? 0 : 1;
    const overdueB = b.status === 'open' && b.dueAt && Date.parse(b.dueAt) < Date.now() ? 0 : 1;
    return overdueA - overdueB || priority[a.priority] - priority[b.priority] || compareTimestamps(a.dueAt, b.dueAt);
  }), [scopedTasks, showCompleted, kindFilter]);
  const openTasks = tasks.filter((task) => task.status === 'open');
  const scopeOpenTasks = scopedTasks.filter((task) => task.status === 'open');
  const dueToday = scopeOpenTasks.filter((task) => task.dueAt && shanghaiDateKey(task.dueAt) === today).length;
  const scopeOverdue = scopeOpenTasks.filter((task) => task.dueAt !== null && Date.parse(task.dueAt) < Date.now()).length;
  const overdue = openTasks.filter((task) => task.dueAt !== null && Date.parse(task.dueAt) < Date.now()).length;
  const mineName = workspace.members.find((member) => member.id === session.actor.memberId)?.displayName ?? session.actor.displayName;
  const workScopeLabel = isManager ? '团队' : isOps ? '运营' : '个人';
  const creatorTileCount = isManager
    ? workspace.creators.filter((creator) => creator.ownerMemberId !== null && workspace.scope.teamIds.includes(creator.teamId)).length
    : workspace.creators.filter((creator) => creator.ownerMemberId === session.actor.memberId).length;
  const demo = selectDemoWalkthrough(workspace, { memberId: session.actor.memberId, role: session.actor.role }, session.dataMode);
  const dailyStart = selectDailyStartingPoint(workspace, { memberId: session.actor.memberId, role: session.actor.role });
  const shortcuts = isOps
    ? [{ label: '样品申请', href: '/samples' }, { label: '运营任务', href: '/tasks' }]
    : session.actor.role === 'bd'
      ? [{ label: '我的达人', href: '/creators?scope=mine' }, { label: '寄样申请', href: '/samples' }, { label: '上播排期', href: '/schedule' }]
      : [{ label: '团队达人', href: '/creators?scope=team' }, { label: '寄样申请', href: '/samples' }, { label: '上播排期', href: '/schedule' }];

  async function completeTask(task: WorkTask) {
    try {
      await run({ type: 'task.complete', taskId: task.id, expectedVersion: task.version, completedAt: new Date().toISOString(), note: null });
      toast.success('任务已完成');
    } catch (error) { toast.error(error instanceof Error ? error.message : '操作失败，请重试。'); }
  }

  const visibleTasks = tasksOnly ? tasks : openTasks.slice(0, 3);
  const emptyHref = isOps ? '/samples' : session.actor.role === 'bd' && creatorTileCount === 0 ? '/public-pool' : dailyStart.href;
  const emptyAction = isOps ? '查看样品履约' : session.actor.role === 'bd' && creatorTileCount === 0 ? '查看公海达人' : dailyStart.actionLabel;

  return <div className={`page-stack ${tasksOnly ? 'business-tasks-page' : 'today-page business-today-page'}`}>
    <PageHeading title={tasksOnly ? '跟进任务' : `今日工作，${mineName}`} description={tasksOnly ? '查看未完成任务和历史记录。' : '先处理今天需要推进的工作。'} actions={tasksOnly && <Link className="button button-outline" to="/">返回今日工作台</Link>} />
    {!tasksOnly && <>
      <section className="today-start-panel" aria-labelledby="today-start-title">
        <div className="today-start-copy">
          <p className="onboarding-eyebrow"><CalendarCheck2 size={13} />今日起点</p>
          <h2 id="today-start-title">{session.dataMode === 'demo' && demo.status === 'ready' ? `${demo.plan.caseLabel}：${demo.plan.creatorName}` : dailyStart.title}</h2>
          <p>{session.dataMode === 'demo' && demo.status === 'ready' ? '按达人、寄样申请、上播排期和数据复盘逐步浏览。' : session.dataMode === 'demo' && demo.status === 'unsupported_role' ? demo.message : dailyStart.description}</p>
        </div>
        <div className="today-start-action">
          {session.dataMode === 'demo' && demo.status === 'ready' ? <Button onClick={() => start(demo.plan)}><PackageCheck size={15} />开始演示<ArrowRight size={14} /></Button>
            : session.dataMode === 'demo' && demo.status === 'unsupported_role' ? <Link className="button" to={demo.fallbackHref}><PackageCheck size={15} />{demo.fallbackLabel}<ArrowRight size={14} /></Link>
              : <Link className="button" to={dailyStart.href}>{dailyStart.actionLabel}<ArrowRight size={14} /></Link>}
        </div>
        <nav className="today-shortcuts" aria-label="常用入口"><span className="onboarding-shortcuts-label">常用入口</span>{shortcuts.slice(0, 3).map((shortcut) => <Link className="onboarding-shortcut" to={shortcut.href} key={shortcut.href}>{shortcut.label}<ArrowRight size={12} /></Link>)}</nav>
        {session.dataMode === 'demo' && demo.status === 'missing_creator' && <p className="onboarding-action-note">{demo.message}</p>}
      </section>
      <div className="page-grid metrics-grid today-metrics">
        <MetricTile label={`${workScopeLabel}今日待办`} value={dueToday} sub="今天到期" icon={<CalendarCheck2 size={15} />} href="/tasks" tone="blue" />
        <MetricTile label={`${workScopeLabel}已逾期`} value={scopeOverdue} sub="截止时间已过" icon={<AlertTriangle size={15} />} href="/tasks" tone={scopeOverdue ? 'orange' : 'green'} />
        {isOps ? <MetricTile label="待发货样品" value={workspace.metrics.sampleBacklog.pendingShipment} sub="待发货" icon={<PackageCheck size={15} />} href="/samples" tone="orange" /> : <MetricTile label={isManager ? '团队达人' : '我负责的达人'} value={creatorTileCount} sub={isManager ? '已分配达人' : '按负责人统计'} icon={<Users size={15} />} href={isManager ? '/creators?scope=team' : '/creators?scope=mine'} tone="neutral" />}
        {isOps ? <MetricTile label="待签收包裹" value={workspace.metrics.sampleBacklog.pendingReceiptPackages} sub="已登记且未签收" icon={<PackageCheck size={15} />} href="/samples" tone="orange" /> : <MetricTile label="待处理样品" value={workspace.metrics.sampleBacklog.pendingApproval + workspace.metrics.sampleBacklog.pendingShipment + workspace.metrics.sampleBacklog.pendingReceiptPackages} sub={`包含审批、发货和签收`} icon={<PackageCheck size={15} />} href="/samples" tone="orange" />}
      </div>
    </>}
    <Panel className={tasksOnly ? '' : 'today-tasks-preview'} title={tasksOnly ? '任务列表' : isManager ? '团队待办' : isOps ? '运营待办' : '需要你处理'} description={tasksOnly ? `${openTasks.length} 条未完成任务${overdue ? ` · ${overdue} 条已逾期` : ''}` : `${openTasks.length} 条未完成任务${overdue ? ` · ${overdue} 条已逾期` : ''} · 显示优先处理的待办`} action={tasksOnly ? <Button variant="outline" size="sm" onClick={() => setShowCompleted(!showCompleted)}>{showCompleted ? '隐藏已完成' : '查看已完成'}</Button> : <Link className="button button-outline small-button" to="/tasks">查看全部<ArrowRight size={12} /></Link>}>
      {tasksOnly && <div className="toolbar"><select className="filter-select" value={kindFilter} onChange={(event) => setKindFilter(event.target.value)} aria-label="按任务类型筛选"><option value="all">所有任务类型</option>{Object.entries(kindLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><span className="table-result-count">{showCompleted ? '包含已完成任务' : '只显示开放任务'}</span></div>}
      {visibleTasks.length === 0 ? <EmptyState title={tasksOnly && showCompleted ? '还没有任务记录' : '当前没有待办'} description={scopedTasks.length === 0 ? '跟进达人或创建业务事项后，相关任务会显示在这里。' : tasksOnly ? '可调整任务类型筛选，或返回今日工作台查看起步建议。' : '可以查看团队达人、样品履约或公海资源，继续推进下一步。'} action={<Link className="button button-outline" to={emptyHref}>{emptyAction}<ArrowRight size={14} /></Link>} /> : <div className="table-wrap"><table className="data-table task-table"><thead><tr><th>任务</th><th>关联达人</th><th>负责人</th><th>截止时间</th><th>优先级</th><th>状态</th><th className="text-right">操作</th></tr></thead><tbody>{visibleTasks.map((task) => <TaskRow key={task.id} task={task} onComplete={() => void completeTask(task)} running={running} />)}</tbody></table></div>}
    </Panel>
    {tasksOnly && <div className="page-bottom-note"><Clock3 size={13} />工作日：{today}；逾期任务按截止时间计算。</div>}
  </div>;
}

function TaskRow({ task, onComplete, running }: { task: WorkTask; onComplete: () => void; running: boolean }) {
  const { workspace, session } = useWorkbench();
  const creator = task.creatorId ? workspace.creators.find((item) => item.id === task.creatorId) : undefined;
  const owner = workspace.members.find((member) => member.id === task.ownerMemberId);
  const isOverdue = task.status === 'open' && task.dueAt !== null && Date.parse(task.dueAt) < Date.now();
  const canComplete = task.status === 'open' && task.ownerMemberId !== null && task.requiredCapability === null && ['followup', 'other'].includes(task.kind) && (task.relatedType === null || task.relatedType === 'creator');
  const teamScope = session.actor.role === 'manager' || session.actor.role === 'admin' ? 'team' : 'mine';
  const path = taskDestination(task, workspace, teamScope);
  const workflowTask = task.requiredCapability !== null || !canComplete;
  return <tr>
    <td><span className="table-primary">{task.title}</span><span className="table-secondary">{kindLabels[task.kind]}</span></td>
    <td>{creator ? <Link className="table-primary text-link" to={path}>{creator.accounts[0]?.displayName ?? creator.name}</Link> : <span className="text-muted">未关联达人</span>}{task.relatedId && <span className="table-secondary">记录 {task.relatedId.slice(0, 7)}</span>}</td>
    <td>{owner?.displayName ?? (task.requiredCapability ? capabilityLabels[task.requiredCapability] ?? '权限队列' : '—')}</td>
    <td><span className={isOverdue ? 'text-danger' : ''}>{task.dueAt ? formatDateTime(task.dueAt) : '无截止时间'}</span>{isOverdue && <span className="table-secondary text-danger">已逾期</span>}</td>
    <td><StatusPill value={task.priority} label={{ high: '高', normal: '普通', low: '低' }[task.priority]} tone={task.priority === 'high' ? 'red' : task.priority === 'normal' ? 'blue' : 'neutral'} /></td>
    <td><StatusPill value={task.status} /></td>
    <td className="table-action-cell">{task.status === 'open' ? workflowTask ? <Link className="button button-outline small-button" to={path}>去处理<ArrowRight size={12} /></Link> : <Button variant="outline" size="sm" className="small-button" onClick={onComplete} disabled={running}><Check size={13} />完成</Button> : <span className="text-muted">{task.completedAt ? formatDateTime(task.completedAt) : '—'}</span>}</td>
  </tr>;
}

function taskDestination(task: WorkTask, workspace: ReturnType<typeof useWorkbench>['workspace'], teamScope: 'team' | 'mine') {
  const id = task.relatedId;
  if (task.relatedType === 'sample') return `/samples${id ? `?q=${encodeURIComponent(id)}` : ''}`;
  if (task.relatedType === 'cooperation') return `/cooperations${id ? `?q=${encodeURIComponent(id)}` : ''}`;
  if (task.relatedType === 'delivery') {
    const cooperationId = id ? workspace.deliveries.find((delivery) => delivery.id === id)?.cooperationId : undefined;
    return `/cooperations${cooperationId ? `?q=${encodeURIComponent(cooperationId)}` : ''}`;
  }
  if (task.relatedType === 'schedule') return `/schedule${id ? `?scheduleId=${encodeURIComponent(id)}` : ''}`;
  if (task.relatedType === 'creator') return `/creators?scope=${teamScope}${id ? `&creatorId=${encodeURIComponent(id)}` : ''}`;
  return task.creatorId ? `/creators?scope=${teamScope}&creatorId=${encodeURIComponent(task.creatorId)}` : '/creators';
}
