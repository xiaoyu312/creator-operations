import { useMemo, useState, type FormEvent } from 'react';
import '../operations-surfaces.css';
import { toast } from 'sonner';
import { Plus, Target as TargetIcon } from 'lucide-react';
import type { TeamMonthlyTargetMetric, TeamMonthlyTargetWorkspaceItem } from '@shared/types';
import { useWorkbench } from '../workbench-context';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { EmptyState, FormField, formatMoney, Modal, PageHeading, Panel, StatusPill } from '../components/workbench';
import { canManageBusiness, isObservedInShanghaiMonth, parseNonnegativeCents, parseNonnegativeInteger, shanghaiMonthValue } from '../lib/business-ui';

const metricLabels: Record<TeamMonthlyTargetMetric, string> = { paid_gmv: '成交金额', approved_deliveries: '验收交付数', new_contacts: '新建联达人数' };

export default function TargetsPage() {
  const { session, workspace } = useWorkbench();
  const canManage = canManageBusiness(session.actor.role);
  const isAdmin = session.actor.role === 'admin';
  const [teamId, setTeamId] = useState(session.actor.teamId);
  const [month, setMonth] = useState(shanghaiMonthValue());
  const [targetOpen, setTargetOpen] = useState(false);
  const [editing, setEditing] = useState<TeamMonthlyTargetWorkspaceItem | null>(null);
  const teams = workspace.teams.filter((team) => isAdmin || team.id === session.actor.teamId);
  const effectiveTeamId = isAdmin ? teamId : session.actor.teamId;
  const targets = canManage ? workspace.teamMonthlyTargets : [];
  const selectedTargets = targets.filter((target) => target.teamId === effectiveTeamId && target.month === month).sort((a, b) => metricOrder(a.metric) - metricOrder(b.metric));
  const knownPaidValue = selectedTargets.filter((target) => target.metric === 'paid_gmv').reduce((sum, target) => sum + target.actualValue, 0);
  const paidCoverageNeedsReview = selectedTargets.some((target) => target.metric === 'paid_gmv' && paidGmvCoverageNeedsReview(target, workspace.orders, workspace.metrics.dataCoverage.importHistoryVisible, workspace.metrics.dataCoverage.importedBatches, workspace.metrics.observedAt));
  const hasUnknownPaid = selectedTargets.some((target) => target.metric === 'paid_gmv' && (target.actualUnknownCount ?? 0) > 0);
  const monthTargets = useMemo(() => targets.filter((target) => target.month === month), [targets, month]);

  return <div className="page-stack ops-page ops-page--targets">
    <PageHeading title="团队月目标" actions={canManage && <Button onClick={() => setTargetOpen(true)}><Plus size={15} />设置目标</Button>} />
    {canManage && <div className="page-grid metrics-grid"><div className="small-metric"><span>目标月份</span><strong>{month}</strong></div><div className="small-metric"><span>团队</span><strong>{teams.length}</strong></div><div className="small-metric"><span>已设目标</span><strong>{monthTargets.length}</strong></div><div className="small-metric"><span>成交金额</span><strong>{paidCoverageNeedsReview ? '待补充' : formatMoney(knownPaidValue)}</strong><small>{hasUnknownPaid ? '部分金额待补充' : ''}</small></div></div>}
    <Panel title="月度目标">
      {canManage ? <>
        <div className="toolbar"><label className="date-filter-label">团队{isAdmin ? <select className="native-select" value={effectiveTeamId} onChange={(event) => setTeamId(event.target.value)} aria-label="选择业务团队">{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select> : <Input aria-label="当前业务团队" value={teams.find((team) => team.id === effectiveTeamId)?.name ?? effectiveTeamId} readOnly disabled />}</label><label className="date-filter-label">目标月份<Input aria-label="选择目标月份" type="month" value={month} onChange={(event) => { if (event.target.value) setMonth(event.target.value); }} /></label><span className="toolbar-spacer" /><Button variant="outline" size="sm" onClick={() => setTargetOpen(true)}><Plus size={13} />新增指标目标</Button></div>
        {selectedTargets.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>目标指标</th><th className="numeric">目标值</th><th className="numeric">实际值</th><th>差额 / 完成率</th><th>完成情况</th><th className="text-right">操作</th></tr></thead><tbody>{selectedTargets.map((target) => <TargetRow key={target.id} target={target} onEdit={() => setEditing(target)} />)}</tbody></table></div> : <EmptyState title="本月还没有设定目标" description="设置目标后查看进度。" icon={<TargetIcon size={21} />} action={<Button size="sm" onClick={() => setTargetOpen(true)}><Plus size={14} />设置目标</Button>} />}
      </> : <EmptyState title="仅管理者可设置团队目标" icon={<TargetIcon size={21} />} />}
    </Panel>
    {canManage && targetOpen && <TeamTargetDialog key={`${session.actor.memberId}:${session.actor.role}:new`} open onOpenChange={setTargetOpen} teamId={effectiveTeamId} month={month} teams={teams} />}
    {canManage && editing && targets.some((item) => item.id === editing.id) && <TeamTargetDialog key={`${session.actor.memberId}:${session.actor.role}:${editing.id}`} open target={targets.find((item) => item.id === editing.id)!} onOpenChange={(open) => { if (!open) setEditing(null); }} teamId={editing.teamId} month={editing.month} teams={teams} />}
  </div>;
}

function TargetRow({ target, onEdit }: { target: TeamMonthlyTargetWorkspaceItem; onEdit: () => void }) {
  const { workspace } = useWorkbench();
  const team = workspace.teams.find((item) => item.id === target.teamId);
  const moneyMetric = target.metric === 'paid_gmv';
  const actualUnknownCount = 'actualUnknownCount' in target ? target.actualUnknownCount : 0;
  const actualComplete = 'actualComplete' in target ? target.actualComplete : actualUnknownCount === 0;
  const noVisiblePaidOrders = moneyMetric && !workspace.orders.some((order) => order.teamId === target.teamId && order.status === 'paid' && order.paidAt !== null && isObservedInShanghaiMonth(order.paidAt, target.month, workspace.metrics.observedAt));
  const actualCoverageMissing = moneyMetric && workspace.metrics.dataCoverage.importHistoryVisible && (workspace.metrics.dataCoverage.importedBatches === 0 || noVisiblePaidOrders);
  const actualCoverageUnavailable = moneyMetric && !workspace.metrics.dataCoverage.importHistoryVisible;
  const targetText = formatTargetValue(target.targetValue, moneyMetric);
  const actualText = actualCoverageUnavailable ? '待补充' : actualCoverageMissing ? '待导入订单' : formatTargetValue(target.actualValue, moneyMetric);
  const ratio = target.targetValue > 0 && !actualCoverageUnavailable && !actualCoverageMissing ? target.actualValue / target.targetValue : null;
  const gap = Math.max(target.targetValue - target.actualValue, 0);
  const isPartial = !actualComplete || actualCoverageUnavailable || actualCoverageMissing;
  const sourceText = actualCoverageUnavailable ? '待补充' : noVisiblePaidOrders ? '暂无订单' : actualCoverageMissing ? '待导入订单' : actualUnknownCount > 0 ? `${actualUnknownCount} 笔金额待补充` : '已更新';
  return <tr>
    <td><span className="table-primary">{metricLabels[target.metric]}</span><span className="table-secondary">{team?.name ?? '待补充'} · {target.month}</span></td>
    <td className="numeric">{targetText}</td>
    <td className="numeric"><span className="table-primary">{actualText}</span>{actualUnknownCount > 0 && <span className="table-secondary">已知金额小计</span>}</td>
    <td>{ratio === null ? <span className="text-muted">未计算</span> : <><span className="table-primary">{target.targetValue === 0 ? '—' : `${(ratio * 100).toFixed(1)}%`}</span><span className="table-secondary">{isPartial ? '部分数据差额' : '差额'} {formatTargetValue(gap, moneyMetric)}</span></>}</td>
    <td>{isPartial ? <StatusPill value="unknown" label={sourceText} tone="orange" /> : <StatusPill value="recorded" label={sourceText} tone="neutral" />}</td>
    <td className="table-action-cell"><Button variant="outline" size="sm" className="small-button" onClick={onEdit}>调整目标</Button></td>
  </tr>;
}

function TeamTargetDialog({ target, open, onOpenChange, teamId, month, teams }: { target?: TeamMonthlyTargetWorkspaceItem; open: boolean; onOpenChange: (open: boolean) => void; teamId: string; month: string; teams: ReturnType<typeof useWorkbench>['workspace']['teams'] }) {
  const { run, running, workspace } = useWorkbench();
  const [error, setError] = useState('');
  const usedMetrics = new Set(workspace.teamMonthlyTargets.filter((item) => item.teamId === teamId && item.month === month).map((item) => item.metric));
  const [selectedMetric, setSelectedMetric] = useState<TeamMonthlyTargetMetric>(target?.metric ?? 'paid_gmv');
  const metric = target?.metric ?? selectedMetric;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); const form = new FormData(event.currentTarget);
    const chosenTeamId = target?.teamId ?? String(form.get('teamId') ?? teamId);
    const chosenMonth = target?.month ?? String(form.get('month') ?? month);
    const chosenMetric = target?.metric ?? String(form.get('metric') ?? selectedMetric) as TeamMonthlyTargetMetric;
    const rawValue = String(form.get('targetValue') ?? '').trim();
    const targetValue = chosenMetric === 'paid_gmv' ? parseNonnegativeCents(rawValue) : parseNonnegativeInteger(rawValue);
    if (targetValue === null) { setError(chosenMetric === 'paid_gmv' ? '请输入有效金额。' : '请输入有效整数。'); return; }
    const existing = workspace.teamMonthlyTargets.find((item) => item.teamId === chosenTeamId && item.month === chosenMonth && item.metric === chosenMetric);
    try {
      await run({ type: 'teamTarget.upsert', teamId: chosenTeamId, month: chosenMonth, metric: chosenMetric, targetValue, expectedVersion: target?.version ?? existing?.version ?? 0 });
      toast.success(target ? '团队目标已更新' : '团队目标已创建'); onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存目标失败，请重试。'); }
  }
  const selectedTeam = teams.find((item) => item.id === (target?.teamId ?? teamId));
  return <Modal open={open} onOpenChange={onOpenChange} title={target ? '调整团队目标' : '设置团队目标'}>
    <form className="modal-form" onSubmit={submit}>
      {target ? <div className="detail-grid"><div className="detail-cell"><span>团队</span><strong>{selectedTeam?.name ?? '待补充'}</strong></div><div className="detail-cell"><span>月份 / 指标</span><strong>{target.month} · {metricLabels[target.metric]}</strong></div></div> : <div className="form-grid"><FormField label="团队" required><select className="native-select" name="teamId" defaultValue={teamId} required>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></FormField><FormField label="月份" required><Input name="month" type="month" defaultValue={month} required /></FormField><FormField label="目标指标" required className="span-2"><select className="native-select" name="metric" value={metric} onChange={(event) => setSelectedMetric(event.target.value as TeamMonthlyTargetMetric)} required>{(Object.keys(metricLabels) as TeamMonthlyTargetMetric[]).map((item, index) => <option key={`${item}-${index}`} value={item}>{metricLabels[item]}{usedMetrics.has(item) ? '（已设置，保存后会更新）' : ''}</option>)}</select></FormField></div>}
      <FormField label={metric === 'paid_gmv' ? '目标金额（元）' : '目标数量'} required hint={metric === 'paid_gmv' ? '最多填写到分。' : '填写整数。'}><Input name="targetValue" type="number" min={0} step={metric === 'paid_gmv' ? '0.01' : '1'} inputMode={metric === 'paid_gmv' ? 'decimal' : 'numeric'} defaultValue={target ? displayTargetInput(target.targetValue, metric === 'paid_gmv') : ''} required /></FormField>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running}>{running ? '保存中…' : '保存目标'}</Button></div>
    </form>
  </Modal>;
}

function formatTargetValue(value: number, isMoney: boolean) {
  return isMoney ? formatMoney(value) : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value);
}

function displayTargetInput(value: number, isMoney: boolean) {
  return isMoney ? (value / 100).toFixed(2) : String(value);
}

function metricOrder(metric: TeamMonthlyTargetMetric) {
  return metric === 'paid_gmv' ? 0 : metric === 'approved_deliveries' ? 1 : 2;
}

function paidGmvCoverageNeedsReview(target: TeamMonthlyTargetWorkspaceItem, orders: ReturnType<typeof useWorkbench>['workspace']['orders'], importHistoryVisible: boolean, importedBatches: number, observedAt: string) {
  if (!importHistoryVisible || importedBatches === 0) return true;
  return !orders.some((order) => order.teamId === target.teamId && order.status === 'paid' && order.paidAt !== null && isObservedInShanghaiMonth(order.paidAt, target.month, observedAt));
}
