import { useEffect, useMemo, useState, type FormEvent } from 'react';
import '../operations-surfaces.css';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Check, Plus, Search, X } from 'lucide-react';
import type { CreatorProductProposal, CreatorProductProposalItem } from '@shared/types';
import { useWorkbench } from '../workbench-context';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { EmptyState, FormField, Modal, PageHeading, Panel, StatusPill, formatDateTime, formatMoney } from '../components/workbench';
import { compareTimestamps } from '../lib/time';

const proposalStatusLabels: Record<CreatorProductProposal['status'], string> = {
  draft: '草稿', proposed: '待反馈', accepted: '已接受', rejected: '已拒绝', converted: '已转合作', cancelled: '已取消',
};
const statusFilters = ['all', 'draft', 'proposed', 'accepted', 'rejected', 'converted', 'cancelled'] as const;

export default function ProposalsPage() {
  const { workspace, session, run, refresh, running } = useWorkbench();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<(typeof statusFilters)[number]>('all');
  const actorKey = `${session.actor.principalId}:${session.actor.role}`;
  const [createOpenFor, setCreateOpenFor] = useState<string | null>(null);
  const [editingTarget, setEditingTarget] = useState<{ actorKey: string; proposalId: string } | null>(null);
  const [outcomeTarget, setOutcomeTarget] = useState<{ actorKey: string; proposalId: string; outcome: 'accepted' | 'rejected' } | null>(null);
  const [cancelTarget, setCancelTarget] = useState<{ actorKey: string; proposalId: string } | null>(null);
  const canWrite = session.actor.role === 'bd';
  const canManageTeam = session.actor.role === 'manager' || session.actor.role === 'admin';
  const createOpen = createOpenFor === actorKey;
  const editing = editingTarget?.actorKey === actorKey && canWrite
    ? workspace.creatorProductProposals.find((proposal) => proposal.id === editingTarget.proposalId && proposal.status === 'draft') ?? null
    : null;
  const currentOutcomeTarget = outcomeTarget?.actorKey === actorKey && canWrite
    ? workspace.creatorProductProposals.find((proposal) => proposal.id === outcomeTarget.proposalId && proposal.status === 'proposed') ?? null
    : null;
  const currentCancelTarget = cancelTarget?.actorKey === actorKey
    ? workspace.creatorProductProposals.find((proposal) => proposal.id === cancelTarget.proposalId && ['draft', 'proposed', 'accepted'].includes(proposal.status) && canCancelProposal(proposal)) ?? null
    : null;
  useEffect(() => {
    setCreateOpenFor(null);
    setEditingTarget(null);
    setOutcomeTarget(null);
    setCancelTarget(null);
  }, [actorKey]);
  const proposals = useMemo(() => workspace.creatorProductProposals.filter((proposal) => {
    if (status !== 'all' && proposal.status !== status) return false;
    const creator = workspace.creators.find((item) => item.id === proposal.creatorId);
    const text = `${proposal.title} ${creator?.name ?? ''} ${creator?.accounts.map((account) => account.displayName).join(' ') ?? ''} ${proposal.items.map((item) => item.productName).join(' ')}`.toLowerCase();
    return !query.trim() || text.includes(query.trim().toLowerCase());
  }).sort((a, b) => compareTimestamps(a.updatedAt, b.updatedAt, 'desc')), [workspace.creatorProductProposals, workspace.creators, status, query]);

  function canCancelProposal(proposal: CreatorProductProposal) {
    if (canManageTeam) return true;
    return canWrite && workspace.creators.some((creator) => creator.id === proposal.creatorId && creator.ownerMemberId === session.actor.memberId);
  }

  async function submitProposal(proposal: CreatorProductProposal) {
    try {
      await run({ type: 'proposal.submit', proposalId: proposal.id, expectedVersion: proposal.version });
      await refresh();
      toast.success('已记录沟通，等待达人反馈。');
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : '提交提案失败'); }
  }

  async function convertProposal(proposal: CreatorProductProposal) {
    try {
      await run({ type: 'proposal.convert', proposalId: proposal.id, expectedVersion: proposal.version });
      await refresh();
      toast.success('合作草稿已创建，提交后进入审核。');
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : '转成合作草稿失败'); }
  }

  return <div className="page-stack ops-page ops-page--proposals">
    <PageHeading title="推品提案" actions={canWrite && <Button onClick={() => setCreateOpenFor(actorKey)}><Plus size={15} />新建推品提案</Button>} />
    <Panel title="提案记录">
      <div className="toolbar"><label className="search-field"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索提案、达人或商品" aria-label="搜索推品提案" /></label><select className="filter-select" value={status} onChange={(event) => setStatus(event.target.value as (typeof statusFilters)[number])} aria-label="按提案状态筛选"><option value="all">全部状态</option>{statusFilters.filter((value) => value !== 'all').map((value) => <option key={value} value={value}>{proposalStatusLabels[value]}</option>)}</select><span className="toolbar-spacer" /><span className="table-result-count">{proposals.length} 条提案</span></div>
      {proposals.length ? <div className="table-wrap"><table className="data-table proposal-table"><thead><tr><th>提案 / 达人</th><th>商品</th><th>状态</th><th>沟通时间</th><th className="text-right">操作</th></tr></thead><tbody>{proposals.map((proposal) => {
        const creator = workspace.creators.find((item) => item.id === proposal.creatorId);
        return <tr key={proposal.id}>
          <td><span className="table-primary">{proposal.title}</span><span className="table-secondary">{creator?.accounts.find((account) => account.active)?.displayName ?? creator?.name ?? '达人信息暂不可用'} · {proposal.id.slice(0, 8)}</span></td>
          <td>{proposal.items.map((item) => <span className="table-secondary proposal-product" key={item.storeAssortmentId}>{item.productName}{item.sku ? ` · ${item.sku}` : ''} · {formatMoney(item.livePriceCents)} 直播价</span>)}<span className="table-secondary">{proposal.sampleRequirement === 'required' ? '需寄样' : '无需寄样'} · {proposal.deliveryRequirement}</span></td>
          <td><StatusPill value={proposal.status} label={proposalStatusLabels[proposal.status]} tone={proposal.status === 'accepted' || proposal.status === 'converted' ? 'green' : proposal.status === 'rejected' ? 'red' : proposal.status === 'proposed' ? 'blue' : 'neutral'} />{proposal.outcomeNote && <span className="table-secondary">{proposal.outcomeNote}</span>}</td>
          <td>{proposal.proposedAt ? formatDateTime(proposal.proposedAt) : '尚未记录'}</td>
          <td className="table-action-cell"><div className="inline-actions">
            {canWrite && proposal.status === 'draft' && <><Button variant="outline" size="sm" className="small-button" onClick={() => setEditingTarget({ actorKey, proposalId: proposal.id })}>编辑草稿</Button><Button size="sm" className="small-button" onClick={() => void submitProposal(proposal)}>记录已沟通</Button></>}
            {canWrite && proposal.status === 'proposed' && <><Button size="sm" className="small-button" onClick={() => setOutcomeTarget({ actorKey, proposalId: proposal.id, outcome: 'accepted' })}><Check size={12} />记录接受</Button><Button variant="outline" size="sm" className="small-button" onClick={() => setOutcomeTarget({ actorKey, proposalId: proposal.id, outcome: 'rejected' })}><X size={12} />记录拒绝</Button></>}
            {canWrite && proposal.status === 'accepted' && <Button variant="outline" size="sm" className="small-button" onClick={() => void convertProposal(proposal)}>转成合作草稿</Button>}
            {['draft', 'proposed', 'accepted'].includes(proposal.status) && canCancelProposal(proposal) && <Button variant="outline" size="sm" className="small-button" onClick={() => setCancelTarget({ actorKey, proposalId: proposal.id })} disabled={running}>关闭提案</Button>}
            {proposal.convertedCooperationId && <Link className="link-button" to={`/cooperations?cooperationId=${encodeURIComponent(proposal.convertedCooperationId)}`}>查看合作草稿</Link>}
          </div></td>
        </tr>;
      })}</tbody></table></div> : <EmptyState title={query ? '没有匹配提案' : '还没有推品提案'} description={query ? '调整搜索词或状态。' : canWrite ? '选择你负责的达人和可用商品，创建商品提案。' : '达人商务创建提案后，可在这里查看团队记录。'} action={canWrite && !query && <Button size="sm" onClick={() => setCreateOpenFor(actorKey)}><Plus size={14} />新建提案</Button>} />}
    </Panel>
    {createOpen && canWrite && <ProposalDraftDialog key={`${actorKey}:create`} open onOpenChange={(open) => { if (!open) setCreateOpenFor(null); }} />}
    {editing && <ProposalDraftDialog key={`${actorKey}:${editing.id}`} proposal={editing} open onOpenChange={(open) => { if (!open) setEditingTarget(null); }} />}
    {currentOutcomeTarget && outcomeTarget && <ProposalOutcomeDialog key={`${actorKey}:${currentOutcomeTarget.id}`} proposal={currentOutcomeTarget} outcome={outcomeTarget.outcome} open onOpenChange={(open) => { if (!open) setOutcomeTarget(null); }} />}
    {currentCancelTarget && <ProposalCancelDialog key={`${actorKey}:${currentCancelTarget.id}`} proposal={currentCancelTarget} open onOpenChange={(open) => { if (!open) setCancelTarget(null); }} />}
  </div>;
}

function ProposalDraftDialog({ proposal, open, onOpenChange }: { proposal?: CreatorProductProposal; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { workspace, session, run, running, refresh } = useWorkbench();
  const [error, setError] = useState('');
  const [creatorId, setCreatorId] = useState(proposal?.creatorId ?? '');
  const [assortmentIds, setAssortmentIds] = useState<string[]>(proposal?.items.map((item) => item.storeAssortmentId) ?? []);
  const baselineAssortmentIds = proposal?.items.map((item) => item.storeAssortmentId) ?? [];
  const selectionChanged = proposal ? baselineAssortmentIds.slice().sort().join(',') !== assortmentIds.slice().sort().join(',') : true;
  const creators = workspace.creators.filter((creator) => creator.ownerMemberId === session.actor.memberId);
  const selectedCreatorId = creators.some((creator) => creator.id === creatorId) ? creatorId : '';
  const currentAssortments = workspace.storeAssortments.filter((item) => {
    const store = workspace.manualStores.find((record) => record.id === item.storeId);
    const product = workspace.products.find((record) => record.id === item.productId);
    const now = Date.now();
    const withinValidity = (!item.validFrom || Date.parse(item.validFrom) <= now) && (!item.validUntil || Date.parse(item.validUntil) >= now);
    return item.active && Boolean(store?.active) && Boolean(product?.active) && withinValidity;
  });
  const oldItems = new Map((proposal?.items ?? []).map((item) => [item.storeAssortmentId, item]));
  const currentById = new Map(currentAssortments.map((item) => [item.id, item]));
  const selectableIds = new Set([...currentAssortments.map((item) => item.id), ...assortmentIds]);
  const proposalItems: Array<{ id: string; snapshot?: CreatorProductProposalItem }> = [...selectableIds].map((id) => ({ id, snapshot: oldItems.get(id) }));

  function toggleAssortment(id: string) {
    setAssortmentIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    const form = new FormData(event.currentTarget);
    if (!proposal && !creators.some((creator) => creator.id === creatorId)) { setError('请选择你负责的达人。'); return; }
    if (!assortmentIds.length) { setError('请至少选择一件可用商品。'); return; }
    if (proposal && selectionChanged && assortmentIds.some((id) => !currentById.has(id))) { setError('所选商品已停用或过期，请取消选择后改用可用商品。'); return; }
    try {
      if (proposal) {
        await run({ type: 'proposal.updateDraft', proposalId: proposal.id, expectedVersion: proposal.version, title: String(form.get('title') ?? ''), deliveryRequirement: String(form.get('deliveryRequirement') ?? ''), sampleRequirement: String(form.get('sampleRequirement') ?? 'required') as 'required' | 'none', ...(selectionChanged ? { assortmentIds } : {}) });
        toast.success('提案草稿已更新');
      } else {
        await run({ type: 'proposal.create', creatorId, title: String(form.get('title') ?? ''), deliveryRequirement: String(form.get('deliveryRequirement') ?? ''), sampleRequirement: String(form.get('sampleRequirement') ?? 'required') as 'required' | 'none', assortmentIds });
        toast.success('推品提案草稿已创建');
      }
      await refresh(); onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存提案失败'); }
  }

  return <Modal open={open} onOpenChange={onOpenChange} title={proposal ? '编辑推品提案草稿' : '新建推品提案'}>
    <form className="modal-form" onSubmit={submit}>
      <div className="form-grid">
        {!proposal && <FormField label="达人" required className="span-2"><select className="native-select" value={selectedCreatorId} onChange={(event) => setCreatorId(event.target.value)} required><option value="">选择你负责的达人</option>{creators.map((creator) => <option key={creator.id} value={creator.id}>{creator.accounts.find((account) => account.active)?.displayName ?? creator.name}</option>)}</select></FormField>}
        <FormField label="提案标题" required className="span-2"><Input name="title" required defaultValue={proposal?.title ?? ''} placeholder="例如：秋季护肤直播组合" /></FormField>
        <FormField label="交付要求" required className="span-2"><Textarea name="deliveryRequirement" rows={3} required defaultValue={proposal?.deliveryRequirement ?? ''} placeholder="说明拟议的直播、短视频或其他交付内容" /></FormField>
        <FormField label="样品要求" required><select className="native-select" name="sampleRequirement" defaultValue={proposal?.sampleRequirement ?? 'required'}><option value="required">需要寄样</option><option value="none">无需寄样</option></select></FormField>
      </div>
      <div className="proposal-assortment-select"><div><strong>选择商品</strong><span>已停用的商品和店铺不能加入提案。</span></div>{proposalItems.length ? proposalItems.map(({ id, snapshot }) => {
        const assortment = currentById.get(id);
        const store = assortment ? workspace.manualStores.find((record) => record.id === assortment.storeId) : undefined;
        const product = assortment ? workspace.products.find((record) => record.id === assortment.productId) : undefined;
        const isAvailable = Boolean(assortment && store?.active && product?.active);
        const old = snapshot;
        const checked = assortmentIds.includes(id);
        return <label className={`proposal-assortment-option${!isAvailable ? ' is-stale' : ''}`} key={id}><input type="checkbox" checked={checked} disabled={!isAvailable && !checked} onChange={() => toggleAssortment(id)} /><span><strong>{product ? `${product.brand} · ${product.name}` : old?.productName ?? '历史商品'}</strong><small>{store?.name ?? (old ? '店铺暂不可用' : '店铺已停用')} · {product?.sku ?? old?.sku ?? '无 SKU'} · 直播价 {formatMoney(assortment?.livePriceCents ?? old?.livePriceCents ?? null)} · 达人佣金 {assortment?.creatorCommissionBps == null && old?.creatorCommissionBps == null ? '—' : `${((assortment?.creatorCommissionBps ?? old?.creatorCommissionBps ?? 0) / 100).toFixed(2)}%`}{!isAvailable ? ' · 已停用或过期' : ''}</small></span></label>;
      }) : <EmptyState title="没有可用商品" description="请先添加店铺、商品和货盘条款。" action={<Link className="button button-outline" to="/assortments">查看商品货盘</Link>} />}</div>
      {proposal?.items.some((item) => !currentById.has(item.storeAssortmentId)) && <div className="notice notice-warning">这件商品已停用或过期，不能用于提交提案或转为合作。请取消选择后改用可用商品。</div>}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running || (!proposal && !creators.length) || !proposalItems.length}>{running ? '保存中…' : proposal ? '保存草稿' : '创建草稿'}</Button></div>
    </form>
  </Modal>;
}

function ProposalOutcomeDialog({ proposal, outcome, open, onOpenChange }: { proposal: CreatorProductProposal; outcome: 'accepted' | 'rejected'; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { run, running, refresh } = useWorkbench();
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    const form = new FormData(event.currentTarget);
    try {
      await run({ type: 'proposal.recordOutcome', proposalId: proposal.id, expectedVersion: proposal.version, outcome, note: String(form.get('note') ?? '') || null });
      toast.success(outcome === 'accepted' ? '已记录达人接受；可继续转为合作草稿。' : '已记录达人拒绝结果。');
      await refresh(); onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存结果失败'); }
  }
  return <Modal open={open} onOpenChange={onOpenChange} title={outcome === 'accepted' ? '记录达人接受' : '记录达人拒绝'}>
    <form className="modal-form" onSubmit={submit}><FormField label="结果说明" required={outcome === 'rejected'}><Textarea name="note" rows={3} required={outcome === 'rejected'} defaultValue={proposal.outcomeNote ?? ''} placeholder={outcome === 'rejected' ? '拒绝时请填写原因' : '可填写达人反馈或需要后续核对的信息'} /></FormField>{error && <p className="field-error" role="alert">{error}</p>}<div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running}>{running ? '保存中…' : '确认记录'}</Button></div></form>
  </Modal>;
}

function ProposalCancelDialog({ proposal, open, onOpenChange }: { proposal: CreatorProductProposal; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { run, running, refresh } = useWorkbench();
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    const form = new FormData(event.currentTarget);
    const reason = String(form.get('reason') ?? '').trim();
    if (!reason) { setError('请填写关闭原因。'); return; }
    try {
      await run({ type: 'proposal.cancel', proposalId: proposal.id, expectedVersion: proposal.version, reason });
      await refresh();
      toast.success('提案已关闭，关闭原因已记录。');
      onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '关闭提案失败'); }
  }
  return <Modal open={open} onOpenChange={onOpenChange} title="关闭推品提案" description="关闭后不能再记录接受或转为合作，请填写关闭原因。">
    <form className="modal-form" onSubmit={submit}>
      <div className="notice notice-warning">即将关闭「{proposal.title}」。</div>
      <FormField label="关闭原因" required><Textarea name="reason" rows={3} required maxLength={4000} placeholder="例如：商品调整、合作计划变化或信息核实未通过" /></FormField>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running}>{running ? '关闭中…' : '确认关闭提案'}</Button></div>
    </form>
  </Modal>;
}
