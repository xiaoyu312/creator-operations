import { useEffect, useMemo, useState, type FormEvent } from 'react';
import '../operations-surfaces.css';
import '../schedule-workflow.css';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, ArrowRight, CalendarClock, CalendarDays, CalendarPlus, Check, ClipboardCheck, Clock3, List as ListIcon, Plus } from 'lucide-react';
import { PLATFORMS, type Cooperation, type LiveSchedule, type Platform } from '@shared/types';
import { useWorkbench } from '../workbench-context';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { EmptyState, FormField, Modal, PageHeading, Panel, StatusPill, formatDateTime, shanghaiDateTimeInput, shanghaiInputToIso } from '../components/workbench';
import { compareTimestamps } from '../lib/time';
import {
  addDaysToDateKey,
  filterSchedulesForWeek,
  findScheduleConflicts,
  getScheduleWeekDays,
  readSchedulePageState,
  shanghaiDateKey,
  withSchedulePageState,
  type ScheduleStatusFilter,
  type ScheduleView,
} from '../lib/schedule-view';
import { platformLabel } from '../lib/platform-presentation';
import { CreatorCooperationPanel } from '../components/CreatorCooperationPanel';
import { CooperationActionDialog, CooperationDetail } from './CooperationsPage';

const weekDays = ['一', '二', '三', '四', '五', '六', '日'];
const openScheduleStatuses = new Set(['planned', 'rescheduled']);
const detailStatusFilters = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '待开播' },
  { value: 'completed', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
] as const;
type CooperationActionKind = 'decision' | 'cancel' | 'waive' | 'delivery';

export default function SchedulePage() {
  const { workspace, session } = useWorkbench();
  const [searchParams, setSearchParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<LiveSchedule | null>(null);
  const [action, setAction] = useState<'reschedule' | 'complete' | 'cancel' | null>(null);
  const [selectedCooperation, setSelectedCooperation] = useState<Cooperation | null>(null);
  const [cooperationDetailOpen, setCooperationDetailOpen] = useState(false);
  const [cooperationAction, setCooperationAction] = useState<CooperationActionKind | null>(null);
  const requestedScheduleId = searchParams.get('scheduleId');
  const requestedCreatorId = searchParams.get('creatorId') ?? '';
  const requestedCreate = searchParams.get('create') === '1';
  const linkedSchedule = requestedScheduleId ? workspace.schedules.find((item) => item.id === requestedScheduleId) : undefined;
  const pageState = readSchedulePageState(searchParams, new Date(), linkedSchedule?.plannedStartAt);
  const canCreateSchedule = session.actor.role !== 'ops';
  const availableCreators = useMemo(() => workspace.creators.filter((creator) => session.actor.role !== 'bd' || creator.ownerMemberId === session.actor.memberId), [workspace.creators, session.actor.memberId, session.actor.role]);
  const initialCreatorId = availableCreators.some((creator) => creator.id === requestedCreatorId) ? requestedCreatorId : '';
  const days = getScheduleWeekDays(pageState.weekStart);
  const dateFrom = days[0];
  const dateTo = days[6];
  const todayKey = shanghaiDateKey(new Date());
  useEffect(() => {
    if (!requestedScheduleId) return;
    const schedule = workspace.schedules.find((item) => item.id === requestedScheduleId);
    if (schedule) setSelected(schedule);
  }, [requestedScheduleId, workspace.schedules]);
  useEffect(() => {
    if (requestedCreate && canCreateSchedule) setCreateOpen(true);
  }, [requestedCreate, canCreateSchedule]);
  useEffect(() => {
    if (initialCreatorId && canCreateSchedule) setCreateOpen(true);
  }, [initialCreatorId, canCreateSchedule]);
  const ownerFilter = session.actor.role === 'bd' ? session.actor.memberId : undefined;
  const schedules = useMemo(() => workspace.schedules.filter((item) => !ownerFilter || item.ownerMemberId === ownerFilter).sort((a, b) => compareTimestamps(a.plannedStartAt, b.plannedStartAt)), [workspace.schedules, ownerFilter]);
  const weekSchedules = useMemo(() => filterSchedulesForWeek(schedules, pageState.weekStart, 'all'), [schedules, pageState.weekStart]);
  const filteredSchedules = useMemo(() => filterSchedulesForWeek(schedules, pageState.weekStart, pageState.status), [schedules, pageState.weekStart, pageState.status]);
  const openCount = schedules.filter((item) => openScheduleStatuses.has(item.status)).length;
  const overdue = workspace.metrics.schedules.overdue;
  useEffect(() => {
    const next = withSchedulePageState(searchParams, pageState);
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
  }, [pageState.view, pageState.weekStart, pageState.status, searchParams, setSearchParams]);
  function updatePageState(change: Partial<{ view: ScheduleView; weekStart: string; status: ScheduleStatusFilter }>) {
    setSearchParams(withSchedulePageState(searchParams, change), { replace: true });
  }
  function openScheduleDetails(schedule: LiveSchedule) {
    setSelected(schedule);
    setAction(null);
    const next = new URLSearchParams(searchParams);
    next.set('scheduleId', schedule.id);
    setSearchParams(next, { replace: true });
  }
  function openCooperationDetails(cooperationId: string) {
    const cooperation = workspace.cooperations.find((item) => item.id === cooperationId);
    if (!cooperation) return;
    setSelectedCooperation(cooperation);
    setCooperationAction(null);
    setCooperationDetailOpen(true);
  }
  function closeCooperationDetails(open: boolean) {
    setCooperationDetailOpen(open);
    if (!open && !cooperationAction) setSelectedCooperation(null);
  }
  function openCooperationAction(item: Cooperation, kind: CooperationActionKind) {
    setSelectedCooperation(item);
    setCooperationDetailOpen(false);
    setCooperationAction(kind);
  }
  function changeCreateOpen(open: boolean) {
    if (!canCreateSchedule) return;
    setCreateOpen(open);
    const next = new URLSearchParams(searchParams);
    if (open) next.set('create', '1');
    else next.delete('create');
    setSearchParams(next, { replace: true });
  }

  return <div className="page-stack ops-page ops-page--schedule">
    <PageHeading title="直播排期" description="按周安排直播，跟进改期、开播与交付。" actions={canCreateSchedule ? <Button onClick={() => changeCreateOpen(true)}><CalendarPlus size={15} />新增排期</Button> : undefined} />
    <div className="page-grid metrics-grid schedule-metrics"><div className="small-metric"><span>未来排期</span><strong>{workspace.metrics.schedules.upcoming}</strong></div><div className="small-metric"><span>当前开放排期</span><strong>{openCount}</strong></div><div className="small-metric"><span>本周场次</span><strong>{weekSchedules.length}</strong></div><div className="small-metric"><span>逾期未完成</span><strong>{overdue}</strong></div></div>
    <Panel className="schedule-workflow-panel" title={pageState.view === 'calendar' ? '周日历' : '周列表'} description={`${dateFrom} 至 ${dateTo} · ${filteredSchedules.length} 场 · 按计划开始时间展示`} action={<div className="schedule-panel-controls"><div className="schedule-view-switch" role="group" aria-label="排期视图"><Button variant={pageState.view === 'calendar' ? 'default' : 'outline'} size="sm" aria-pressed={pageState.view === 'calendar'} onClick={() => updatePageState({ view: 'calendar' })}><CalendarDays size={14} />日历</Button><Button variant={pageState.view === 'list' ? 'default' : 'outline'} size="sm" aria-pressed={pageState.view === 'list'} onClick={() => updatePageState({ view: 'list' })}><ListIcon size={14} />列表</Button></div><div className="week-controls"><Button variant="outline" size="icon" aria-label="上一周" onClick={() => updatePageState({ weekStart: addDaysToDateKey(pageState.weekStart, -7) })}><ArrowLeft size={14} /></Button><Button variant="outline" size="sm" onClick={() => updatePageState({ weekStart: readSchedulePageState(new URLSearchParams(), new Date()).weekStart })}>本周</Button><Button variant="outline" size="icon" aria-label="下一周" onClick={() => updatePageState({ weekStart: addDaysToDateKey(pageState.weekStart, 7) })}><ArrowRight size={14} /></Button></div></div>}>
      <div className="schedule-workflow-toolbar"><label className="date-filter-label">场次状态<select className="native-select" value={pageState.status} onChange={(event) => updatePageState({ status: event.target.value as ScheduleStatusFilter })} aria-label="按场次状态筛选">{detailStatusFilters.map((filter) => <option key={filter.value} value={filter.value}>{filter.label}</option>)}</select></label><span className="toolbar-spacer" /><span className="table-result-count">{filteredSchedules.length} 场</span></div>
      {pageState.view === 'calendar' ? filteredSchedules.length === 0
        ? <EmptyState title={weekSchedules.length ? '当前筛选条件下没有场次' : '本周没有排期'} description={weekSchedules.length ? '调整场次状态，或切换到其他周查看。' : '选择进行中的合作，为达人安排直播时间；时间冲突会在填写计划时间后提示。'} action={canCreateSchedule ? <Button size="sm" onClick={() => changeCreateOpen(true)}><Plus size={14} />新增排期</Button> : undefined} />
        : <div className="week-calendar" role="group" aria-label={`周排期 ${dateFrom} 至 ${dateTo}`}>
          {days.map((key, index) => {
            const entries = filteredSchedules.filter((item) => shanghaiDateKey(item.plannedStartAt) === key);
            const isToday = key === todayKey;
            return <div className={`calendar-day${isToday ? ' is-today' : ''}`} role="group" key={key} aria-label={`${key} 星期${weekDays[index]}`}><header><span>周{weekDays[index]}</span><strong>{key.slice(5)}</strong>{isToday && <em>今天</em>}</header><div className="calendar-events">{entries.map((item) => <ScheduleEvent key={item.id} item={item} onOpen={() => openScheduleDetails(item)} />)}{!entries.length && <span className="calendar-day-empty">暂无安排</span>}</div></div>;
          })}
        </div>
        : filteredSchedules.length === 0
          ? <EmptyState title={weekSchedules.length ? '当前筛选条件下没有场次' : '本周没有排期'} description={weekSchedules.length ? '调整场次状态，或切换到其他周查看。' : '选择进行中的合作，为达人安排直播时间；时间冲突会在填写计划时间后提示。'} action={canCreateSchedule ? <Button size="sm" onClick={() => changeCreateOpen(true)}><Plus size={14} />新增排期</Button> : undefined} />
          : <div className="table-wrap"><table className="data-table schedule-table"><thead><tr><th>时间 / 场次</th><th>达人</th><th>合作约定</th><th>负责人</th><th>状态</th><th>交付</th><th className="text-right">操作</th></tr></thead><tbody>{filteredSchedules.map((item) => <ScheduleRow key={item.id} item={item} onOpen={() => openScheduleDetails(item)} openCooperation={openCooperationDetails} openAction={(kind) => { setSelected(item); setAction(kind); }} />)}</tbody></table></div>}
    </Panel>
    {canCreateSchedule && <CreateScheduleDialog open={createOpen} onOpenChange={changeCreateOpen} initialCreatorId={initialCreatorId} schedules={schedules} />}
    {selected && <ScheduleDetail item={workspace.schedules.find((record) => record.id === selected.id) ?? selected} open={!action && !cooperationDetailOpen && !cooperationAction} onOpenChange={(open) => { if (!open) { setSelected(null); const next = new URLSearchParams(searchParams); next.delete('scheduleId'); setSearchParams(next, { replace: true }); } }} openAction={(kind) => setAction(kind)} openCooperation={openCooperationDetails} />}
    {selected && action && <ScheduleActionDialog item={workspace.schedules.find((record) => record.id === selected.id) ?? selected} kind={action} onOpenChange={(open) => { if (!open) setAction(null); }} />}
    {selectedCooperation && <CooperationDetail item={workspace.cooperations.find((record) => record.id === selectedCooperation.id) ?? selectedCooperation} open={cooperationDetailOpen} onOpenChange={closeCooperationDetails} onAction={openCooperationAction} />}
    {selectedCooperation && cooperationAction && <CooperationActionDialog item={workspace.cooperations.find((record) => record.id === selectedCooperation.id) ?? selectedCooperation} kind={cooperationAction} onOpenChange={(open) => { if (!open) { setCooperationAction(null); setCooperationDetailOpen(true); } }} />}
  </div>;
}

function ScheduleEvent({ item, onOpen }: { item: LiveSchedule; onOpen: () => void }) {
  const { workspace } = useWorkbench();
  const creator = workspace.creators.find((record) => record.id === item.creatorId);
  return <button className={`calendar-event event-${item.status}`} onClick={onOpen}><span className="event-time">{formatDateTime(item.plannedStartAt).slice(-5)}</span><strong>{item.title}</strong><small>{creator?.accounts[0]?.displayName ?? creator?.name ?? '达人'}</small><StatusPill value={item.status} /></button>;
}

function ScheduleRow({ item, onOpen, openCooperation, openAction }: { item: LiveSchedule; onOpen: () => void; openCooperation: (cooperationId: string) => void; openAction: (kind: 'reschedule' | 'complete' | 'cancel') => void }) {
  const { workspace } = useWorkbench();
  const creator = workspace.creators.find((record) => record.id === item.creatorId);
  const cooperation = workspace.cooperations.find((record) => record.id === item.cooperationId);
  const owner = workspace.members.find((member) => member.id === item.ownerMemberId);
  const deliveries = workspace.deliveries.filter((delivery) => delivery.scheduleId === item.id);
  const clash = openScheduleStatuses.has(item.status) && findScheduleConflicts(workspace.schedules, item.ownerMemberId, item.plannedStartAt, item.plannedEndAt).some((other) => other.id !== item.id);
  return <tr><td><span className="table-primary">{formatDateTime(item.plannedStartAt)}</span><button className="link-button table-secondary" type="button" onClick={onOpen}>{item.title}{clash && <b className="conflict-label">时间冲突</b>}</button></td><td>{creator?.accounts[0]?.displayName ?? creator?.name ?? '—'}</td><td>{cooperation?.title ?? '合作约定暂不可用'}</td><td>{owner?.displayName ?? '—'}</td><td><StatusPill value={item.status} /></td><td>{deliveries.filter((delivery) => delivery.status === 'approved').length}/{deliveries.filter((delivery) => delivery.required).length} 项验收</td><td className="table-action-cell"><div className="inline-actions">{cooperation && <Button variant="outline" size="sm" className="small-button" onClick={() => openCooperation(item.cooperationId)}><ClipboardCheck size={13} />交付验收</Button>}{openScheduleStatuses.has(item.status) && <><Button variant="outline" size="sm" className="small-button" onClick={() => openAction('complete')}><Check size={13} />登记实际</Button><button className="link-button" onClick={() => openAction('reschedule')}>改期</button><button className="link-button button-danger" onClick={() => openAction('cancel')}>取消</button></>}{item.status === 'completed' ? <span className="text-muted">实际 {formatDateTime(item.actualEndAt)}</span> : item.status === 'cancelled' ? <span className="text-muted">已取消</span> : null}</div></td></tr>;
}

const schedulableCooperationStatuses = new Set(['pending_samples_shipment', 'pending_samples_receipt', 'pending_delivery']);

function CreateScheduleDialog({ open, onOpenChange, initialCreatorId, schedules }: { open: boolean; onOpenChange: (open: boolean) => void; initialCreatorId: string; schedules: LiveSchedule[] }) {
  const { workspace, session, run, running } = useWorkbench();
  const [creatorId, setCreatorId] = useState(initialCreatorId);
  const [cooperationId, setCooperationId] = useState('');
  const [platform, setPlatform] = useState<Platform | ''>('');
  const [error, setError] = useState('');
  const [plannedStart, setPlannedStart] = useState(() => shanghaiDateTimeInput(new Date(Date.now() + 60 * 60 * 1000)));
  const [plannedEnd, setPlannedEnd] = useState(() => shanghaiDateTimeInput(new Date(Date.now() + 2 * 60 * 60 * 1000)));
  const creator = workspace.creators.find((item) => item.id === creatorId);
  const availableCreators = workspace.creators.filter((item) => session.actor.role !== 'bd' || item.ownerMemberId === session.actor.memberId);
  const availableCooperations = workspace.cooperations.filter((item) => item.creatorId === creatorId && (session.actor.role !== 'bd' || item.ownerMemberId === session.actor.memberId) && schedulableCooperationStatuses.has(item.status));
  const selected = availableCooperations.find((item) => item.id === cooperationId);
  const availablePlatforms = PLATFORMS.filter((item) => creator?.accounts.some((account) => account.platform === item));
  const conflicts = useMemo(() => {
    if (!selected || !plannedStart || !plannedEnd) return [];
    return findScheduleConflicts(schedules, selected.ownerMemberId, shanghaiInputToIso(plannedStart), shanghaiInputToIso(plannedEnd));
  }, [plannedEnd, plannedStart, schedules, selected]);

  useEffect(() => {
    if (!open) return;
    setCreatorId(initialCreatorId);
    setCooperationId('');
    setPlatform('');
    setError('');
    setPlannedStart(shanghaiDateTimeInput(new Date(Date.now() + 60 * 60 * 1000)));
    setPlannedEnd(shanghaiDateTimeInput(new Date(Date.now() + 2 * 60 * 60 * 1000)));
  }, [initialCreatorId, open]);

  function changeCreator(value: string) {
    setCreatorId(value);
    setCooperationId('');
    setPlatform('');
    setError('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); const formElement = event.currentTarget; const form = new FormData(formElement);
    const cooperation = availableCooperations.find((item) => item.id === cooperationId);
    if (!creator) { setError('请选择达人。'); return; }
    if (!cooperation) { setError('请先选择已通过审核的合作。'); return; }
    if (!platform || !availablePlatforms.includes(platform)) { setError('请先为该达人添加平台账号。'); return; }
    try {
      await run({ type: 'schedule.create', cooperationId: cooperation.id, expectedCooperationVersion: cooperation.version, cooperationLineId: String(form.get('lineId') ?? '') || null, title: String(form.get('title') ?? ''), platform, roomId: String(form.get('roomId') ?? '') || null, plannedStartAt: shanghaiInputToIso(String(form.get('startAt') ?? '')), plannedEndAt: shanghaiInputToIso(String(form.get('endAt') ?? '')) });
      toast.success('排期已创建'); onOpenChange(false); setCreatorId(''); setCooperationId(''); setPlatform(''); formElement.reset();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '创建失败'); }
  }

  return <Modal open={open} onOpenChange={onOpenChange} title="新增直播排期" description="填写计划开始和结束时间；实际开播时间会在完成登记时单独记录。">
    <form className="modal-form" onSubmit={submit}>
      <section className="detail-section schedule-cooperation-form-section">
        <div className="timeline-title-row"><h3>合作信息</h3><span>{creator ? `${availableCooperations.length} 笔可排期` : '先选择达人'}</span></div>
        <FormField label="达人" required><select className="native-select" value={creatorId} onChange={(event) => changeCreator(event.target.value)} required><option value="">选择达人</option>{availableCreators.map((item) => { const account = item.accounts.find((entry) => entry.active) ?? item.accounts[0]; return <option key={item.id} value={item.id}>{account?.displayName ?? item.name}</option>; })}</select></FormField>
        <FormField label="合作约定" required><select className="native-select" value={cooperationId} onChange={(event) => setCooperationId(event.target.value)} required disabled={!creator || !availableCooperations.length}><option value="">{creator ? '选择已审核的合作' : '先选择达人'}</option>{availableCooperations.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.lines.length} 项商品</option>)}</select></FormField>
        {selected && selected.lines.length > 0 && <FormField label="关联商品"><select className="native-select" name="lineId"><option value="">不限单个商品</option>{selected.lines.map((line) => <option key={line.id} value={line.id}>{line.productName} · {line.sku ?? '无 SKU'}</option>)}</select></FormField>}
        {creator && availableCooperations.length === 0 && <>
          <div className="notice notice-warning"><span>该达人暂无可排期的合作约定，请先创建并审核通过合作约定。</span></div>
          <CreatorCooperationPanel creatorId={creator.id} />
        </>}
        {creatorId && !creator && <div className="notice notice-warning"><span>无法找到这位达人，请重新选择。</span></div>}
      </section>
      <section className="detail-section schedule-planning-form-section">
        <div className="timeline-title-row"><h3>排期计划</h3><span>实际开播时间在完成登记时填写</span></div>
        <FormField label="开播平台" required><select className="native-select" name="platform" value={platform} onChange={(event) => setPlatform(event.target.value as Platform | '')} required disabled={!availablePlatforms.length}><option value="">{creator ? '选择已登记的平台' : '先选择达人'}</option>{availablePlatforms.map((item) => <option key={item} value={item}>{platformLabel(item)}</option>)}</select></FormField>
        {creator && availablePlatforms.length === 0 && <div className="notice notice-warning"><span>请先为该达人添加平台账号，再安排排期。</span></div>}
        <FormField label="场次标题" required><Input name="title" required placeholder="例如：周五品牌专场" /></FormField>
        <div className="form-grid"><FormField label="计划开始" required><Input name="startAt" type="datetime-local" value={plannedStart} onChange={(event) => setPlannedStart(event.target.value)} required /></FormField><FormField label="计划结束" required><Input name="endAt" type="datetime-local" value={plannedEnd} onChange={(event) => setPlannedEnd(event.target.value)} required /></FormField></div>
        {selected && conflicts.length > 0 && <div className="notice notice-warning schedule-conflict-notice" role="status"><Clock3 size={14} /><span>与 {conflicts.length} 场同一负责人排期时间重叠：{conflicts.slice(0, 3).map((item) => `${item.title}（${formatDateTime(item.plannedStartAt)}）`).join('、')}{conflicts.length > 3 ? '等' : ''}。请核对时间；仍可继续保存。</span></div>}
        <p className="schedule-conflict-hint">选择合作约定后，会按当前可见的排期检查同一负责人的时间冲突。</p>
        <FormField label="直播间标识（可选）"><Input name="roomId" placeholder="平台直播间 ID 或链接标识" /></FormField>
      </section>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running || !selected || !platform}>{running ? '保存中…' : '创建排期'}</Button></div>
    </form>
  </Modal>;
}

function ScheduleDetail({ item, open, onOpenChange, openAction, openCooperation }: { item: LiveSchedule; open: boolean; onOpenChange: (open: boolean) => void; openAction: (kind: 'reschedule' | 'complete' | 'cancel') => void; openCooperation: (cooperationId: string) => void }) {
  const { workspace } = useWorkbench();
  const creator = workspace.creators.find((record) => record.id === item.creatorId);
  const cooperation = workspace.cooperations.find((record) => record.id === item.cooperationId);
  return <Modal open={open} onOpenChange={onOpenChange} title={item.title} description={`${creator?.accounts[0]?.displayName ?? creator?.name ?? '达人'} · ${cooperation?.title ?? '合作约定暂不可用'}`}>
    <div className="detail-summary-row"><StatusPill value={item.status} /><span>负责人：{workspace.members.find((member) => member.id === item.ownerMemberId)?.displayName ?? '—'}</span></div><div className="detail-grid"><div className="detail-cell"><span>计划开始</span><strong>{formatDateTime(item.plannedStartAt)}</strong></div><div className="detail-cell"><span>计划结束</span><strong>{formatDateTime(item.plannedEndAt)}</strong></div><div className="detail-cell"><span>实际开始</span><strong>{formatDateTime(item.actualStartAt)}</strong></div><div className="detail-cell"><span>实际结束</span><strong>{formatDateTime(item.actualEndAt)}</strong></div></div>{item.history.length > 0 && <div className="schedule-history"><strong>改期历史</strong>{item.history.map((version, index) => <p key={`${version.changedAt}-${index}`}>{formatDateTime(version.plannedStartAt)} – {formatDateTime(version.plannedEndAt)} · {version.reason}</p>)}</div>}{item.reviewUrl && <a href={item.reviewUrl} target="_blank" rel="noreferrer" className="evidence-link">打开复盘链接</a>}
    <div className="detail-actions">{cooperation && <Button variant="outline" onClick={() => openCooperation(cooperation.id)}><ClipboardCheck size={14} />交付验收</Button>}{openScheduleStatuses.has(item.status) && <><Button onClick={() => openAction('complete')}><Check size={14} />登记实际开播</Button><Button variant="outline" onClick={() => openAction('reschedule')}>改期</Button><Button variant="outline" className="button-danger" onClick={() => openAction('cancel')}>取消排期</Button></>}</div>
  </Modal>;
}

function ScheduleActionDialog({ item, kind, onOpenChange }: { item: LiveSchedule; kind: 'reschedule' | 'complete' | 'cancel'; onOpenChange: (open: boolean) => void }) {
  const { run, running } = useWorkbench(); const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setError(''); const form = new FormData(event.currentTarget);
    try {
      if (kind === 'reschedule') await run({ type: 'schedule.reschedule', scheduleId: item.id, expectedVersion: item.version, plannedStartAt: shanghaiInputToIso(String(form.get('startAt') ?? '')), plannedEndAt: shanghaiInputToIso(String(form.get('endAt') ?? '')), changedAt: new Date().toISOString(), reason: String(form.get('reason') ?? '') });
      if (kind === 'complete') await run({ type: 'schedule.complete', scheduleId: item.id, expectedVersion: item.version, actualStartAt: String(form.get('actualStartAt') ?? '') ? shanghaiInputToIso(String(form.get('actualStartAt') ?? '')) : null, actualEndAt: shanghaiInputToIso(String(form.get('actualEndAt') ?? '')), reviewUrl: String(form.get('reviewUrl') ?? '') || null });
      if (kind === 'cancel') await run({ type: 'schedule.cancel', scheduleId: item.id, expectedVersion: item.version, cancelledAt: new Date().toISOString(), reason: String(form.get('reason') ?? '') });
      toast.success(kind === 'reschedule' ? '排期已改期' : kind === 'complete' ? '实际开播记录已保存' : '排期已取消'); onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败'); }
  }
  const title = kind === 'reschedule' ? '调整直播排期' : kind === 'complete' ? '登记实际开播' : '取消排期';
  return <Modal open onOpenChange={onOpenChange} title={title} description={item.title}><form className="modal-form" onSubmit={submit}>
    {kind === 'reschedule' && <><div className="form-grid"><FormField label="新计划开始" required><Input name="startAt" type="datetime-local" defaultValue={shanghaiDateTimeInput(new Date(item.plannedStartAt))} required /></FormField><FormField label="新计划结束" required><Input name="endAt" type="datetime-local" defaultValue={shanghaiDateTimeInput(new Date(item.plannedEndAt))} required /></FormField></div><FormField label="改期原因" required><Textarea name="reason" rows={2} required /></FormField></>}
    {kind === 'complete' && <><div className="form-grid"><FormField label="实际开始"><Input name="actualStartAt" type="datetime-local" defaultValue={item.actualStartAt ? shanghaiDateTimeInput(new Date(item.actualStartAt)) : ''} /></FormField><FormField label="实际结束" required><Input name="actualEndAt" type="datetime-local" defaultValue={shanghaiDateTimeInput()} required /></FormField></div><FormField label="复盘链接"><Input name="reviewUrl" type="url" defaultValue={item.reviewUrl ?? ''} placeholder="https://" /></FormField></>}
    {kind === 'cancel' && <FormField label="取消原因" required><Textarea name="reason" rows={3} required /></FormField>}
    {error && <p className="field-error" role="alert">{error}</p>}<div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>返回</Button><Button type="submit" variant={kind === 'cancel' ? 'destructive' : 'default'} disabled={running}>{running ? '保存中…' : '确认'}</Button></div>
  </form></Modal>;
}
