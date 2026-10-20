import { useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { ArrowRightLeft } from 'lucide-react';
import type { WorkspaceSnapshot } from '@shared/types';
import { useWorkbench } from '../workbench-context';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { EmptyState, FormField, Modal, PageHeading, Panel, StatusPill, formatDateTime, shanghaiDateTimeInput, shanghaiInputToIso } from '../components/workbench';
import '../business-surfaces.css';

type MemberRow = WorkspaceSnapshot['members'][number];
function roleLabel(role: MemberRow['role'] | null) { return ({ admin: '管理员', manager: '团队主管', bd: '达人商务', ops: '样品运营' } as Record<string, string>)[role ?? ''] ?? '—'; }

export default function TeamPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { workspace, session, run, running } = useWorkbench();
  const [handoff, setHandoff] = useState<MemberRow | null>(null);
  const [edit, setEdit] = useState<MemberRow | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState('all');
  const teams = workspace.teams.filter((team) => workspace.scope.teamIds.includes(team.id));
  const scopedMembers = workspace.members.filter((member) => workspace.scope.teamIds.includes(member.teamId));
  const members = scopedMembers.filter((member) => selectedTeamId === 'all' || member.teamId === selectedTeamId);
  const teamSummary = useMemo(() => members.map((member) => ({
    member,
    creators: workspace.creators.filter((creator) => creator.ownerMemberId === member.id).length,
    tasks: workspace.tasks.filter((task) => task.ownerMemberId === member.id && task.status === 'open').length,
    samples: workspace.samples.filter((sample) => sample.applicantId === member.id && !['received', 'rejected', 'closed'].includes(sample.status)).length,
    cooperations: workspace.cooperations.filter((item) => item.ownerMemberId === member.id && !['delivered', 'cancelled', 'rejected'].includes(item.status)).length,
  })), [members, workspace.creators, workspace.tasks, workspace.samples, workspace.cooperations]);
  const targets = scopedMembers.filter((member) => member.active);
  const canEditMembers = workspace.scope.canManageMembers;

  const memberPanel = <Panel title={selectedTeamId === 'all' ? '团队成员' : `${teams.find((team) => team.id === selectedTeamId)?.name ?? '团队'}成员`}>
    {teamSummary.length ? <div className="table-wrap"><table className="data-table team-table"><thead><tr><th>成员</th><th>岗位</th><th>负责达人</th><th>待办</th><th>进行中合作</th><th>状态</th><th className="text-right">业务操作</th></tr></thead><tbody>{teamSummary.map(({ member, creators, tasks, samples, cooperations }) => <tr key={member.id}><td><span className="member-cell"><span className="avatar-initial">{member.displayName.slice(0, 1)}</span><span><strong>{member.displayName}</strong><small>{workspace.teams.find((team) => team.id === member.teamId)?.name ?? '团队未配置'}</small></span></span></td><td>{roleLabel(member.role)}</td><td>{creators}</td><td>{tasks}</td><td>{cooperations}<span className="table-secondary">样品申请 {samples} 项</span></td><td><StatusPill value={member.active ? 'active' : 'inactive'} label={member.active ? '已启用' : '已停用'} tone={member.active ? 'green' : 'neutral'} /></td><td className="table-action-cell"><div className="inline-actions">{member.active && member.id !== session.actor.memberId && <Button variant="outline" size="sm" className="small-button" onClick={() => setHandoff(member)}><ArrowRightLeft size={12} />交接工作</Button>}{canEditMembers && <Button variant="ghost" size="sm" className="small-button" onClick={() => setEdit(member)}>成员信息</Button>}</div></td></tr>)}</tbody></table></div> : <EmptyState title="当前团队暂无成员" description="添加成员后，可在这里查看负责的达人和待办。" />}
  </Panel>;
  const handoffPanel = <Panel title="工作交接" description="未完成工作转交后，历史记录仍归原负责人。">
    <div className="handoff-guide"><div><span className="guide-number">01</span><strong>选择需要交接的成员</strong><p>查看待办、达人、样品和进行中合作。</p></div><div><span className="guide-number">02</span><strong>指定接手人和生效时间</strong></div><div><span className="guide-number">03</span><strong>确认任务和合作已转交</strong></div></div>
  </Panel>;

  return <div className={`page-stack business-team-page${embedded ? ' team-page-embedded' : ''}`}>
    {!embedded && <PageHeading title="团队成员" description={session.actor.role === 'manager' ? '查看成员负责的达人、待办和合作。' : '查看团队成员并交接未完成工作。'} />}
    {!embedded && <div className="page-grid metrics-grid team-metrics"><div className="small-metric"><span>团队成员</span><strong>{members.filter((member) => member.active).length}</strong></div><div className="small-metric"><span>开放达人</span><strong>{teamSummary.reduce((sum, row) => sum + row.creators, 0)}</strong></div><div className="small-metric"><span>开放待办</span><strong>{teamSummary.reduce((sum, row) => sum + row.tasks, 0)}</strong></div><div className="small-metric"><span>待处理合作</span><strong>{teamSummary.reduce((sum, row) => sum + row.cooperations, 0)}</strong></div></div>}
    {embedded ? <div className="team-performance-admin-layout">
      <nav className="team-performance-team-groups" aria-label="团队分组">
        <button type="button" aria-pressed={selectedTeamId === 'all'} onClick={() => setSelectedTeamId('all')}><span>全部团队</span><small>{scopedMembers.length}</small></button>
        {teams.map((team) => <button type="button" key={team.id} aria-pressed={selectedTeamId === team.id} onClick={() => setSelectedTeamId(team.id)}><span>{team.name}</span><small>{scopedMembers.filter((member) => member.teamId === team.id).length}</small></button>)}
      </nav>
      <div className="team-performance-admin-content">{memberPanel}{handoffPanel}</div>
    </div> : <>{memberPanel}{handoffPanel}</>}
    {handoff && <HandoffDialog source={handoff} targets={targets.filter((member) => member.id !== handoff.id)} open onOpenChange={(open) => { if (!open) setHandoff(null); }} />}
    {edit && <MemberBusinessDialog member={edit} open onOpenChange={(open) => { if (!open) setEdit(null); }} />}
  </div>;
}

function HandoffDialog({ source, targets, open, onOpenChange }: { source: MemberRow; targets: MemberRow[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { run, running, session } = useWorkbench(); const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setError(''); const form = new FormData(event.currentTarget);
    try {
      await run({ type: 'member.handoff', sourceMemberId: source.id, targetMemberId: String(form.get('targetMemberId') ?? ''), effectiveAt: shanghaiInputToIso(String(form.get('effectiveAt') ?? '')), reason: String(form.get('reason') ?? ''), deactivateSource: form.get('deactivateSource') === 'on' });
      toast.success('工作交接已记录'); onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '交接失败'); }
  }
  return <Modal open={open} onOpenChange={onOpenChange} title={`交接 ${source.displayName} 的工作`} description="未完成工作将转给接手人，历史业绩归属不变。">
    <form className="modal-form" onSubmit={submit}><div className="handoff-counts"><span><strong>{source.displayName}</strong><small>当前负责人</small></span></div><FormField label="接手人" required><select className="native-select" name="targetMemberId" required><option value="">选择启用成员</option>{targets.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select></FormField><FormField label="生效时间" required><Input type="datetime-local" name="effectiveAt" defaultValue={shanghaiDateTimeInput()} required /></FormField><FormField label="交接原因" required><Textarea name="reason" rows={3} required placeholder="例如：团队调整、离职交接" /></FormField>{session.businessWorkspace ? <p className="detail-note">停用成员请到成员管理。</p> : <label className="check-row"><input type="checkbox" name="deactivateSource" />交接完成后停用原成员的业务账号</label>}{error && <p className="field-error" role="alert">{error}</p>}<div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running || targets.length === 0}>{running ? '交接中…' : '确认交接'}</Button></div></form>
  </Modal>;
}

function MemberBusinessDialog({ member, open, onOpenChange }: { member: MemberRow & { version: number }; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { workspace, run, running, session } = useWorkbench(); const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setError(''); const form = new FormData(event.currentTarget);
    const teamId = String(form.get('teamId') ?? member.teamId);
    const active = form.get('active') === 'on';
    if (teamId === member.teamId && active === member.active) { onOpenChange(false); return; }
    try { await run({ type: 'member.update', memberId: member.id, expectedVersion: member.version, teamId, active }); toast.success('业务成员信息已更新'); onOpenChange(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败'); }
  }
  const canManage = workspace.scope.canManageMembers;
  return <Modal open={open} onOpenChange={onOpenChange} title="成员信息" description="调整团队和启用状态。">
    <form className="modal-form" onSubmit={submit}><FormField label="业务团队" required><select className="native-select" name="teamId" defaultValue={member.teamId} disabled={!canManage}>{workspace.teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></FormField><label className="check-row"><input type="checkbox" name="active" defaultChecked={member.active} disabled={!canManage || member.id === session.actor.memberId} />已启用，可被分配为工作接手人</label>{error && <p className="field-error" role="alert">{error}</p>}<div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>{canManage && <Button type="submit" disabled={running}>{running ? '保存中…' : '保存成员信息'}</Button>}</div></form>
  </Modal>;
}
