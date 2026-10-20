import { useState, type FormEvent } from 'react';
import '../operations-surfaces.css';
import { toast } from 'sonner';
import { ExternalLink, FileText, Plus, Search } from 'lucide-react';
import type { CommercialLedgerEntry, CommercialLedgerKind } from '@shared/types';
import { useWorkbench } from '../workbench-context';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { EmptyState, FormField, formatDateTime, formatMoney, Modal, PageHeading, Panel, StatusPill, shanghaiDateTimeInput, shanghaiInputToIso } from '../components/workbench';
import { canManageBusiness, parsePositiveCents } from '../lib/business-ui';

const kindLabels: Record<CommercialLedgerKind, string> = { cooperation_fee: '合作费用', sample_logistics: '样品物流', ad_spend: '投放费用', other: '其他' };

export default function ExpensesPage() {
  const { session, workspace } = useWorkbench();
  const canManage = canManageBusiness(session.actor.role);
  const entries = canManage ? workspace.commercialLedgerEntries : [];
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'recorded' | 'voided'>('all');
  const [teamFilter, setTeamFilter] = useState('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [voiding, setVoiding] = useState<CommercialLedgerEntry | null>(null);
  const effectiveTeamFilter = session.actor.role === 'admin' ? teamFilter : 'all';
  const currentVoiding = voiding ? entries.find((entry) => entry.id === voiding.id) : undefined;
  const filteredEntries = entries.filter((entry) => effectiveTeamFilter === 'all' || entry.teamId === effectiveTeamFilter);
  const recorded = filteredEntries.filter((entry) => entry.status === 'recorded');
  const voided = filteredEntries.filter((entry) => entry.status === 'voided');
  const recordedCents = recorded.reduce((sum, entry) => sum + BigInt(entry.amountCents), 0n);
  const recordedAmount = recordedCents > BigInt(Number.MAX_SAFE_INTEGER) ? '暂无法显示' : formatMoney(Number(recordedCents));
  const visible = filteredEntries.filter((entry) => {
    const statusMatches = statusFilter === 'all' || entry.status === statusFilter;
    const cooperation = workspace.cooperations.find((item) => item.id === entry.cooperationId);
    const asset = workspace.contentAssets.find((item) => item.id === entry.contentAssetId);
    const team = workspace.teams.find((item) => item.id === entry.teamId);
    const searchable = `${entry.title} ${entry.source} ${team?.name ?? ''} ${cooperation?.title ?? ''} ${asset?.title ?? ''}`.toLocaleLowerCase();
    return statusMatches && searchable.includes(query.trim().toLocaleLowerCase());
  });

  return <div className="page-stack ops-page ops-page--expenses">
    <PageHeading title="费用与投放台账" description="登记合作、内容和投放费用。" actions={canManage && <Button onClick={() => setCreateOpen(true)}><Plus size={15} />登记费用</Button>} />
    {canManage && <div className="page-grid metrics-grid"><div className="small-metric"><span>有效记录</span><strong>{recorded.length}</strong></div><div className="small-metric"><span>有效费用合计</span><strong>{recordedAmount}</strong>{recordedCents > BigInt(Number.MAX_SAFE_INTEGER) && <small>金额合计过大，暂无法显示。</small>}</div><div className="small-metric"><span>已作废</span><strong>{voided.length}</strong><small>原记录和原因保留</small></div></div>}
    <Panel title="费用记录">
      {canManage ? <>
        <div className="toolbar"><label className="search-field"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索费用、来源或关联记录" aria-label="搜索费用台账" /></label><label className="date-filter-label">记录状态<select className="native-select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)} aria-label="按台账状态筛选"><option value="all">全部状态</option><option value="recorded">有效</option><option value="voided">已作废</option></select></label>{session.actor.role === 'admin' && <label className="date-filter-label">所属团队<select className="native-select" value={teamFilter} onChange={(event) => setTeamFilter(event.target.value)} aria-label="按所属团队筛选"><option value="all">全部团队</option>{workspace.teams.filter((team) => team.active).map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>}<span className="toolbar-spacer" /><span className="table-result-count">{visible.length} 条记录</span></div>
        {visible.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>费用</th>{session.actor.role === 'admin' && <th>所属团队</th>}<th>日期 / 来源</th><th>关联合作 / 内容</th><th className="numeric">金额</th><th>证据 / 状态</th><th className="text-right">操作</th></tr></thead><tbody>{visible.map((entry) => {
          const cooperation = workspace.cooperations.find((item) => item.id === entry.cooperationId);
          const asset = workspace.contentAssets.find((item) => item.id === entry.contentAssetId);
          const team = workspace.teams.find((item) => item.id === entry.teamId);
          return <tr key={entry.id}><td><span className="table-primary">{entry.title}</span><span className="table-secondary">{kindLabels[entry.kind]}</span></td>{session.actor.role === 'admin' && <td>{team?.name ?? '—'}</td>}<td>{formatDateTime(entry.occurredAt)}<span className="table-secondary">来源：{entry.source}</span></td><td>{cooperation?.title ?? (entry.cooperationId ? '合作信息暂不可用' : '未关联合作')}<span className="table-secondary">{asset?.title ?? (entry.contentAssetId ? '内容信息暂不可用' : '未关联内容')}</span></td><td className="numeric">{formatMoney(entry.amountCents)}</td><td>{entry.evidenceUrl ? <a className="evidence-link" href={entry.evidenceUrl} target="_blank" rel="noreferrer"><ExternalLink size={12} />查看证据</a> : <span className="text-muted">未提供证据链接</span>}<span className="table-secondary"><StatusPill value={entry.status} label={entry.status === 'recorded' ? '有效' : '已作废'} tone={entry.status === 'recorded' ? 'green' : 'neutral'} /></span>{entry.voidReason && <span className="table-secondary">作废原因：{entry.voidReason}</span>}</td><td className="table-action-cell">{entry.status === 'recorded' && <Button variant="ghost" size="sm" className="small-button button-danger" onClick={() => setVoiding(entry)}>作废</Button>}</td></tr>;
        })}</tbody></table></div> : <EmptyState title={query || statusFilter !== 'all' ? '没有匹配记录' : '费用台账为空'} description={query || statusFilter !== 'all' ? '调整搜索词或状态筛选后重试。' : '登记已发生的费用和来源后，可在这里查看。'} icon={<FileText size={21} />} action={<Button size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} />登记费用</Button>} />}
      </> : <EmptyState title="暂无法查看费用台账" description="请联系管理员开通查看权限。" icon={<FileText size={21} />} />}
    </Panel>
    {canManage && createOpen && <LedgerEntryDialog key={`${session.actor.memberId}:${session.actor.role}`} open onOpenChange={setCreateOpen} />}
    {canManage && currentVoiding && <VoidLedgerEntryDialog key={`${session.actor.memberId}:${session.actor.role}:${currentVoiding.id}`} entry={currentVoiding} open onOpenChange={(open) => { if (!open) setVoiding(null); }} />}
  </div>;
}

function LedgerEntryDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { session, workspace, run, running } = useWorkbench();
  const [error, setError] = useState('');
  const canChooseTeam = session.actor.role === 'admin';
  const teams = workspace.teams.filter((team) => team.active && (canChooseTeam || team.id === session.actor.teamId));
  const initialTeamId = teams.find((team) => team.id === session.actor.teamId)?.id ?? teams[0]?.id ?? '';
  const [teamId, setTeamId] = useState(initialTeamId);
  const [cooperationId, setCooperationId] = useState('');
  const [contentAssetId, setContentAssetId] = useState('');
  const cooperations = workspace.cooperations.filter((item) => item.teamId === teamId);
  const contentAssets = workspace.contentAssets.filter((item) => item.teamId === teamId);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); const form = new FormData(event.currentTarget);
    const amount = String(form.get('amount') ?? '').trim();
    const amountCents = parsePositiveCents(amount);
    if (amountCents === null) { setError('金额须大于 0，请填写有效金额。'); return; }
    if (!teamId) { setError('请选择业务团队。'); return; }
    try {
      await run({ type: 'ledgerEntry.create', teamId, title: String(form.get('title') ?? ''), kind: String(form.get('kind') ?? 'other') as CommercialLedgerKind, amountCents, occurredAt: shanghaiInputToIso(String(form.get('occurredAt') ?? '')), source: String(form.get('source') ?? ''), evidenceUrl: String(form.get('evidenceUrl') ?? '') || null, cooperationId: cooperationId || null, contentAssetId: contentAssetId || null });
      toast.success('费用记录已登记'); onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '登记失败，请重试。'); }
  }
  return <Modal open={open} onOpenChange={onOpenChange} title="登记费用" description="记录已发生费用及关联资料。" className="modal-standard modal-wide">
    <form className="modal-form" onSubmit={submit}>
      <div className="form-grid"><FormField label="归属团队" required>{canChooseTeam ? <select className="native-select" value={teamId} onChange={(event) => { setTeamId(event.target.value); setCooperationId(''); setContentAssetId(''); }} aria-label="费用归属团队"><option value="">选择团队</option>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select> : <Input value={workspace.teams.find((team) => team.id === session.actor.teamId)?.name ?? session.actor.teamId} readOnly disabled />}</FormField><FormField label="费用名称" required><Input name="title" required maxLength={300} placeholder="例如：达人合作服务费" /></FormField><FormField label="费用类型" required><select className="native-select" name="kind" defaultValue="cooperation_fee"><option value="cooperation_fee">合作费用</option><option value="sample_logistics">样品物流</option><option value="ad_spend">投放费用</option><option value="other">其他</option></select></FormField><FormField label="金额（元）" required hint="填写实际发生金额，须大于 0。"><Input name="amount" type="number" min="0.01" step="0.01" inputMode="decimal" required /></FormField><FormField label="发生时间" required><Input name="occurredAt" type="datetime-local" defaultValue={shanghaiDateTimeInput()} required /></FormField><FormField label="来源" required hint="填写账单、平台报表、合同等费用依据。"><Input name="source" required maxLength={300} placeholder="例如：平台投放账单" /></FormField><FormField label="证据链接"><Input name="evidenceUrl" type="url" maxLength={2048} placeholder="https://" /></FormField><FormField label="关联合作"><select className="native-select" value={cooperationId} onChange={(event) => setCooperationId(event.target.value)} aria-label="关联合作"><option value="">不关联合作</option>{cooperations.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></FormField><FormField label="关联内容"><select className="native-select" value={contentAssetId} onChange={(event) => setContentAssetId(event.target.value)} aria-label="关联内容"><option value="">不关联内容</option>{contentAssets.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></FormField></div>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="notice notice-info">费用由人工登记，平台账单和结算结果请另行核对。</div>
      <div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running}>{running ? '保存中…' : '登记费用'}</Button></div>
    </form>
  </Modal>;
}

function VoidLedgerEntryDialog({ entry, open, onOpenChange }: { entry: CommercialLedgerEntry; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { run, running } = useWorkbench();
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); const form = new FormData(event.currentTarget);
    try {
      await run({ type: 'ledgerEntry.void', entryId: entry.id, expectedVersion: entry.version, voidReason: String(form.get('voidReason') ?? '') });
      toast.success('费用已作废，原记录和原因仍保留'); onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '作废失败。'); }
  }
  return <Modal open={open} onOpenChange={onOpenChange} title="作废费用记录" description={`${entry.title} · ${formatMoney(entry.amountCents)}`}>
    <form className="modal-form" onSubmit={submit}><div className="notice notice-info">作废后不再计入有效金额，原记录会保留。请填写作废原因。</div><FormField label="作废原因" required><Textarea name="voidReason" required minLength={1} rows={3} placeholder="说明原记录为何需要作废" /></FormField>{error && <p className="field-error" role="alert">{error}</p>}<div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" variant="destructive" disabled={running}>{running ? '保存中…' : '确认作废'}</Button></div></form>
  </Modal>;
}
