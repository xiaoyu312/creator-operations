import { useEffect, useMemo, useState, type FormEvent } from 'react';
import '../operations-surfaces.css';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { CalendarPlus, ClipboardCheck, ExternalLink, Plus, Search, Send } from 'lucide-react';
import type { Cooperation, Delivery } from '@shared/types';
import { useWorkbench } from '../workbench-context';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { EmptyState, FormField, Modal, PageHeading, Panel, StatusPill, formatDateTime, formatMoney, shanghaiDateTimeInput, shanghaiInputToIso } from '../components/workbench';
import { compareTimestamps } from '../lib/time';
import { isContentDeliveryPending } from '../lib/home-insights';
import { parseNonnegativeCents } from '../lib/business-ui';

const cooperationStatuses = ['draft', 'pending_approval', 'rejected', 'pending_samples_shipment', 'pending_samples_receipt', 'pending_delivery', 'delivered', 'cancelled'];

export default function CooperationsPage() {
  const { workspace, session, run, running } = useWorkbench();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedStatus = searchParams.get('status');
  const status = requestedStatus && ['all', ...cooperationStatuses].includes(requestedStatus) ? requestedStatus : 'active';
  const setStatus = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === 'active') next.delete('status'); else next.set('status', value);
    setSearchParams(next, { replace: true });
  };
  const query = searchParams.get('q') ?? '';
  const ownerFilter = searchParams.get('ownerMemberId') ?? 'all';
  const teamFilter = searchParams.get('teamId') ?? 'all';
  const dateFrom = searchParams.get('dateFrom');
  const dateTo = searchParams.get('dateTo');
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<Cooperation | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [actionKind, setActionKind] = useState<'decision' | 'cancel' | 'waive' | 'delivery' | null>(null);
  const requestedCooperationId = searchParams.get('cooperationId');
  useEffect(() => {
    if (!requestedCooperationId) return;
    const item = workspace.cooperations.find((cooperation) => cooperation.id === requestedCooperationId);
    if (item) { setSelected(item); setDetailOpen(true); }
  }, [requestedCooperationId, workspace.cooperations]);
  const canApprove = session.actor.capabilities.includes('cooperation.approve');
  const changeQuery = (value: string) => { const next = new URLSearchParams(searchParams); if (value) next.set('q', value); else next.delete('q'); setSearchParams(next, { replace: true }); };
  const rows = useMemo(() => workspace.cooperations.filter((item) => {
    if (session.actor.role === 'bd' && item.ownerMemberId !== session.actor.memberId) return false;
    if (ownerFilter !== 'all' && item.ownerMemberId !== ownerFilter) return false;
    if (teamFilter !== 'all' && item.teamId !== teamFilter) return false;
    if (status === 'active' && ['rejected', 'delivered', 'cancelled'].includes(item.status)) return false;
    if (status === 'pending_delivery' && !isContentDeliveryPending(item, workspace.deliveries)) return false;
    if (!['all', 'active', 'pending_delivery'].includes(status) && item.status !== status) return false;
    const creator = workspace.creators.find((record) => record.id === item.creatorId);
    const searchText = `${item.title} ${creator?.name ?? ''} ${creator?.accounts.map((account) => account.displayName).join(' ') ?? ''} ${item.id}`.toLowerCase();
    return !query.trim() || searchText.includes(query.trim().toLowerCase());
  }).sort((a, b) => compareTimestamps(a.updatedAt, b.updatedAt, 'desc')), [workspace.cooperations, workspace.creators, workspace.deliveries, session.actor.role, session.actor.memberId, status, query, ownerFilter, teamFilter]);

  async function submitCooperation(item: Cooperation) {
    try { await run({ type: 'cooperation.submit', cooperationId: item.id, expectedVersion: item.version, submittedAt: new Date().toISOString() }); toast.success('合作约定已提交审核'); }
    catch (error) { toast.error(error instanceof Error ? error.message : '提交失败'); }
  }
  function openDetails(item: Cooperation) { setSelected(item); setDetailOpen(true); const next = new URLSearchParams(searchParams); next.set('cooperationId', item.id); setSearchParams(next, { replace: true }); }
  function closeDetails(open: boolean) {
    setDetailOpen(open);
    if (open) return;
    setSelected(null);
    const next = new URLSearchParams(searchParams);
    next.delete('cooperationId');
    setSearchParams(next, { replace: true });
  }
  function openAction(item: Cooperation, kind: NonNullable<typeof actionKind>) { setSelected(item); setDetailOpen(false); setActionKind(kind); }

  return <div className="page-stack ops-page ops-page--cooperations">
    <PageHeading title="合作约定" description="按达人记录商品、样品和交付条件；审核通过后再用于排期。" actions={<Button onClick={() => setCreateOpen(true)}><Plus size={15} />新建合作约定</Button>} />
    <div className="page-grid metrics-grid cooperation-metrics">
      <div className="small-metric"><span>待审核</span><strong>{workspace.metrics.cooperations.pending_approval}</strong></div>
      <div className="small-metric"><span>待寄样 / 签收</span><strong>{workspace.metrics.cooperations.pending_samples_shipment + workspace.metrics.cooperations.pending_samples_receipt}</strong></div>
      <div className="small-metric"><span>待交付</span><strong>{workspace.metrics.cooperations.pending_delivery}</strong></div>
      <div className="small-metric"><span>已交付</span><strong>{workspace.metrics.cooperations.delivered}</strong></div>
    </div>
    <Panel title="合作约定">
      <div className="toolbar"><label className="search-field"><Search size={14} /><input value={query} onChange={(event) => changeQuery(event.target.value)} placeholder="搜索合作主题、达人或编号" aria-label="搜索合作单" /></label><select className="filter-select" value={status} onChange={(event) => setStatus(event.target.value)} aria-label="按合作状态筛选"><option value="active">进行中</option><option value="all">全部状态</option>{cooperationStatuses.map((value) => <option key={value} value={value}>{cooperationLabel(value)}</option>)}</select>{session.actor.role !== 'bd' && <select className="filter-select" value={ownerFilter} onChange={(event) => { const next = new URLSearchParams(searchParams); if (event.target.value === 'all') next.delete('ownerMemberId'); else next.set('ownerMemberId', event.target.value); setSearchParams(next, { replace: true }); }} aria-label="按负责人筛选"><option value="all">全部负责人</option>{workspace.members.filter((member) => teamFilter === 'all' || member.teamId === teamFilter).map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select>}{workspace.scope.teamIds.length > 1 && <select className="filter-select" value={teamFilter} onChange={(event) => { const next = new URLSearchParams(searchParams); if (event.target.value === 'all') next.delete('teamId'); else next.set('teamId', event.target.value); next.delete('ownerMemberId'); setSearchParams(next, { replace: true }); }} aria-label="按团队筛选"><option value="all">全部团队</option>{workspace.teams.filter((team) => workspace.scope.teamIds.includes(team.id)).map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select>}<span className="toolbar-spacer" /><span className="table-result-count">{rows.length} 条合作{dateFrom || dateTo ? ` · 日期：${dateFrom ?? '不限'} 至 ${dateTo ?? '不限'}` : ''}</span></div>
      {rows.length === 0 ? <EmptyState title={workspace.cooperations.length ? '没有符合条件的约定' : '还没有合作约定'} description={workspace.cooperations.length ? '调整搜索词或状态筛选。' : '从达人档案建立约定，添加商品行并提交审核。'} action={<Button size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} />新建合作约定</Button>} /> : (
        <div className="table-wrap"><table className="data-table cooperation-table"><thead><tr><th>合作 / 达人</th><th>商品</th><th>跟进商务</th><th>合作状态</th><th>计划周期</th><th>排期 / 交付</th><th className="text-right">操作</th></tr></thead><tbody>
          {rows.map((item) => {
            const creator = workspace.creators.find((record) => record.id === item.creatorId);
            const owner = workspace.members.find((member) => member.id === item.ownerMemberId);
            const schedules = workspace.schedules.filter((record) => record.cooperationId === item.id);
            const deliveries = workspace.deliveries.filter((record) => record.cooperationId === item.id);
            return <tr key={item.id}><td><button className="link-button table-primary" onClick={() => openDetails(item)}>{item.title}</button><span className="table-secondary">{creator?.accounts[0]?.displayName ?? creator?.name ?? '达人信息暂不可用'} · {item.id.slice(0, 8)}</span></td><td>{item.lines.map((line) => <span className="table-secondary product-line" key={line.id}>{line.productName}{line.sku ? ` · ${line.sku}` : ''}</span>)}</td><td>{owner?.displayName ?? '—'}</td><td><StatusPill value={item.status} label={cooperationLabel(item.status)} /></td><td>{item.startAt ? formatDateTime(item.startAt) : '待定'}<span className="table-secondary">至 {item.endAt ? formatDateTime(item.endAt) : '待定'}</span></td><td><span className="table-primary">{schedules.length} 个排期</span><span className="table-secondary">{deliveries.filter((delivery) => delivery.status === 'approved').length}/{deliveries.filter((delivery) => delivery.required).length} 项交付已验收</span></td><td className="table-action-cell"><div className="inline-actions">{item.status === 'draft' && <Button variant="outline" size="sm" className="small-button" onClick={() => void submitCooperation(item)} disabled={running}>提交审核</Button>}{item.status === 'pending_approval' && canApprove && item.applicantId !== session.actor.memberId && <Button size="sm" className="small-button" onClick={() => openAction(item, 'decision')}>审核</Button>}{['pending_delivery', 'delivered'].includes(item.status) && <Button variant="outline" size="sm" className="small-button" onClick={() => openAction(item, 'delivery')}><ClipboardCheck size={12} />新增交付</Button>}{item.status === 'pending_samples_receipt' && canApprove && <button className="link-button" onClick={() => openAction(item, 'waive')}>免签收</button>}{!['delivered', 'cancelled', 'rejected'].includes(item.status) && <button className="link-button button-danger" onClick={() => openAction(item, 'cancel')}>取消</button>}</div></td></tr>;
          })}
        </tbody></table></div>
      )}
    </Panel>
    <CreateCooperationDialog open={createOpen} onOpenChange={setCreateOpen} />
    {selected && <CooperationDetail item={workspace.cooperations.find((record) => record.id === selected.id) ?? selected} open={detailOpen} onOpenChange={closeDetails} onAction={openAction} />}
    {selected && actionKind && <CooperationActionDialog item={workspace.cooperations.find((record) => record.id === selected.id) ?? selected} kind={actionKind} onOpenChange={(open) => { if (!open) setActionKind(null); }} />}
  </div>;
}

export function cooperationLabel(status: string) { return ({ draft: '草稿', pending_approval: '待审核', rejected: '已驳回', pending_samples_shipment: '待寄样', pending_samples_receipt: '待签收', pending_delivery: '待交付', delivered: '已交付', cancelled: '已取消' } as Record<string, string>)[status] ?? status; }

export function CreateCooperationDialog({ open, onOpenChange, initialCreatorId }: { open: boolean; onOpenChange: (open: boolean) => void; initialCreatorId?: string }) {
  const { workspace, run, running } = useWorkbench();
  const [creatorId, setCreatorId] = useState(initialCreatorId ?? '');
  const [lines, setLines] = useState<Array<{ productId: string; productName: string; sku: string; specification: string; price: string; quantity: string; deliveryRequirement: string }>>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) {
      setCreatorId(initialCreatorId ?? '');
      setLines([]);
      setError('');
    }
  }, [open, initialCreatorId]);
  const effectiveCreatorId = initialCreatorId ?? creatorId;
  const selectedCreator = workspace.creators.find((item) => item.id === effectiveCreatorId);
  const availableCreators = initialCreatorId ? workspace.creators.filter((item) => item.id === initialCreatorId) : workspace.creators.filter((item) => item.ownerMemberId === workspace.actor.memberId);
  function addLine() {
    const product = workspace.products.find((item) => item.active && !lines.some((line) => line.productId === item.id));
    if (product) setLines((current) => [...current, { productId: product.id, productName: product.name, sku: product.sku ?? '', specification: product.specification ?? '', price: '', quantity: '', deliveryRequirement: '', }]);
  }
  function changeLine(index: number, patch: Partial<(typeof lines)[number]>) { setLines((current) => current.map((line, i) => i === index ? { ...line, ...patch } : line)); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); const formElement = event.currentTarget; const form = new FormData(formElement); const creator = workspace.creators.find((item) => item.id === effectiveCreatorId);
    if (!creator) { setError('请选择达人。'); return; }
    if (!lines.length) { setError('请至少添加一项合作商品。'); return; }
    if (lines.some((line) => line.price.trim() && parseNonnegativeCents(line.price) === null)) { setError('约定价格格式不正确，请输入最多两位小数的金额。'); return; }
    const numberLines = lines.map((line) => ({ productId: line.productId || null, productName: line.productName, sku: line.sku || null, specification: line.specification || null, agreedPriceCents: line.price.trim() ? parseNonnegativeCents(line.price) : null, agreedQuantity: line.quantity ? Number(line.quantity) : null, deliveryRequirement: line.deliveryRequirement || String(form.get('deliveryRequirement') ?? ''), note: null }));
    try {
      await run({ type: 'cooperation.create', creatorId: creator.id, expectedCreatorVersion: creator.version, title: String(form.get('title') ?? ''), lines: numberLines, sampleRequirement: String(form.get('sampleRequirement') ?? 'required') as 'required' | 'none', deliveryRequirement: String(form.get('deliveryRequirement') ?? ''), startAt: String(form.get('startAt') ?? '') ? shanghaiInputToIso(String(form.get('startAt') ?? '')) : null, endAt: String(form.get('endAt') ?? '') ? shanghaiInputToIso(String(form.get('endAt') ?? '')) : null, note: String(form.get('note') ?? '') || null });
      toast.success('合作约定草稿已创建'); onOpenChange(false); setCreatorId(''); setLines([]); formElement.reset();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '创建失败'); }
  }
  return <Modal open={open} onOpenChange={onOpenChange} title="新建合作约定" description="先保存草稿并提交审核，通过后即可排期。" className="modal-standard modal-wide">
    <form className="modal-form" onSubmit={submit}>
      <div className="form-grid"><FormField label="达人" required className="span-2">{initialCreatorId ? <Input value={selectedCreator?.accounts[0]?.displayName ?? selectedCreator?.name ?? ''} readOnly /> : <select className="native-select" value={creatorId} onChange={(event) => setCreatorId(event.target.value)} required><option value="">选择我负责的达人</option>{availableCreators.map((creator) => <option key={creator.id} value={creator.id}>{creator.accounts[0]?.displayName ?? creator.name}</option>)}</select>}</FormField><FormField label="合作主题" required className="span-2"><Input name="title" required placeholder="例如：双十一专场合作" /></FormField><FormField label="是否需要样品" required><select className="native-select" name="sampleRequirement"><option value="required">需要寄样</option><option value="none">无需寄样</option></select></FormField><FormField label="预计开始"><Input type="datetime-local" name="startAt" /></FormField><FormField label="预计结束"><Input type="datetime-local" name="endAt" /></FormField><FormField label="交付总要求" required className="span-2"><Textarea name="deliveryRequirement" required rows={2} placeholder="说明需要直播、短视频或其他交付内容" /></FormField></div>
      <div className="line-items-heading"><div><strong>合作商品</strong></div><Button type="button" variant="outline" size="sm" onClick={addLine} disabled={!workspace.products.some((item) => item.active && !lines.some((line) => line.productId === item.id))}><Plus size={13} />添加商品</Button></div>
      {lines.length ? <div className="cooperation-lines">{lines.map((line, index) => <div className="cooperation-line-editor" key={`${line.productId}-${index}`}><div className="cooperation-line-title"><strong>{line.productName}</strong><button className="link-button button-danger" type="button" onClick={() => setLines((current) => current.filter((_, i) => i !== index))}>移除</button></div><div className="form-grid"><FormField label="商品规格"><Input value={line.specification} onChange={(event) => changeLine(index, { specification: event.target.value })} /></FormField><FormField label="SKU"><Input value={line.sku} onChange={(event) => changeLine(index, { sku: event.target.value })} /></FormField><FormField label="约定价格（元）"><Input type="number" min={0} step="0.01" value={line.price} onChange={(event) => changeLine(index, { price: event.target.value })} /></FormField><FormField label="约定数量"><Input type="number" min={1} step={1} value={line.quantity} onChange={(event) => changeLine(index, { quantity: event.target.value })} /></FormField><FormField label="商品交付要求" className="span-2"><Input value={line.deliveryRequirement} onChange={(event) => changeLine(index, { deliveryRequirement: event.target.value })} placeholder="例如：直播间口播，置顶 1 小时" /></FormField></div></div>)}</div> : <div className="line-items-empty">{workspace.products.some((item) => item.active) ? '请添加至少一个商品行。' : '尚未配置可用商品。'}</div>}
      <FormField label="补充说明"><Textarea name="note" rows={2} /></FormField>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running || !lines.length}>{running ? '保存中…' : '保存约定草稿'}</Button></div>
    </form>
  </Modal>;
}

export function CooperationDetail({ item, open, onOpenChange, onAction }: { item: Cooperation; open: boolean; onOpenChange: (open: boolean) => void; onAction: (item: Cooperation, kind: 'decision' | 'cancel' | 'waive' | 'delivery') => void }) {
  const { workspace, session, run, running } = useWorkbench();
  const [submissionTarget, setSubmissionTarget] = useState<Delivery | null>(null);
  const [reviewTarget, setReviewTarget] = useState<Delivery | null>(null);
  const creator = workspace.creators.find((record) => record.id === item.creatorId);
  const schedules = workspace.schedules.filter((record) => record.cooperationId === item.id);
  const deliveries = workspace.deliveries.filter((record) => record.cooperationId === item.id);
  const canApprove = session.actor.capabilities.includes('cooperation.approve');
  async function submit() { try { await run({ type: 'cooperation.submit', cooperationId: item.id, expectedVersion: item.version, submittedAt: new Date().toISOString() }); toast.success('合作约定已提交审核'); } catch (error) { toast.error(error instanceof Error ? error.message : '提交失败'); } }
  return <>
  <Modal open={open} onOpenChange={onOpenChange} title={item.title} description={creator?.accounts[0]?.displayName ?? creator?.name ?? '达人信息暂不可用'} className="modal-standard modal-wide"><div className="cooperation-detail-body">
    <div className="detail-summary-row"><StatusPill value={item.status} label={cooperationLabel(item.status)} /><span>负责人：{workspace.members.find((member) => member.id === item.ownerMemberId)?.displayName ?? '—'}</span><span>创建于 {formatDateTime(item.createdAt)}</span></div>
    <div className="detail-products">{item.lines.map((line) => <div key={line.id} className="detail-product-row"><div><strong>{line.productName}</strong><small>{line.sku ?? '无 SKU'}{line.specification ? ` · ${line.specification}` : ''}</small>{line.storeAssortmentId && <small>达人推广佣金 {line.creatorCommissionBps === null || line.creatorCommissionBps === undefined ? '待定' : `${(line.creatorCommissionBps / 100).toFixed(2)}%`}</small>}{Boolean(line.sellingPointsSnapshot?.length) && <small>{line.sellingPointsSnapshot?.join('；')}</small>}{line.sellingPointEvidenceUrl && <a className="evidence-link" href={line.sellingPointEvidenceUrl} target="_blank" rel="noreferrer">卖点依据</a>}{line.salesCardUrl && <a className="evidence-link" href={line.salesCardUrl} target="_blank" rel="noreferrer">约定手卡</a>}</div><span>{line.agreedPriceCents === null ? '价格待定' : formatMoney(line.agreedPriceCents)}</span><span>{line.agreedQuantity ?? '数量待定'}</span></div>)}</div>
    <div className="detail-grid"><div className="detail-cell"><span>样品要求</span><strong>{item.sampleRequirement === 'required' ? '需要寄样' : '无需寄样'}</strong></div><div className="detail-cell"><span>排期数</span><strong>{schedules.length}</strong></div><div className="detail-cell"><span>交付验收</span><strong>{deliveries.filter((delivery) => delivery.status === 'approved').length}/{deliveries.filter((delivery) => delivery.required).length} 项</strong></div><div className="detail-cell"><span>合作周期</span><strong>{item.startAt ? formatDateTime(item.startAt) : '待定'} – {item.endAt ? formatDateTime(item.endAt) : '待定'}</strong></div></div>
    {item.note && <p className="detail-note">{item.note}</p>}
    <section className="detail-section delivery-list-section"><div className="timeline-title-row"><h3>交付项</h3><span>{deliveries.length} 项</span></div>{deliveries.length ? <div className="delivery-list">{deliveries.map((delivery) => {
      const canSubmit = delivery.ownerMemberId === session.actor.memberId || session.actor.role === 'manager' || session.actor.role === 'admin';
      return <div className="delivery-row" key={delivery.id}><div className="delivery-main"><strong>{delivery.title}</strong><small>{delivery.type === 'live' ? '直播' : delivery.type === 'short_video' ? '短视频' : '其他'} · 截止 {formatDateTime(delivery.dueAt)}{delivery.required ? ' · 必需' : ' · 可选'}</small>{delivery.submissions.at(-1)?.contentUrl && <a href={delivery.submissions.at(-1)?.contentUrl ?? undefined} target="_blank" rel="noreferrer"><ExternalLink size={11} />查看提交内容</a>}</div><StatusPill value={delivery.status} /><div className="delivery-actions">{canSubmit && ['pending_submission', 'returned'].includes(delivery.status) && <Button variant="outline" size="sm" className="small-button" onClick={() => setSubmissionTarget(delivery)}><Send size={12} />{delivery.status === 'returned' ? '重新提交' : '提交交付'}</Button>}{session.actor.capabilities.includes('cooperation.approve') && delivery.status === 'pending_review' && <Button size="sm" className="small-button" onClick={() => setReviewTarget(delivery)}>验收</Button>}</div></div>;
    })}</div> : <p className="text-muted detail-empty-note">暂无交付项，可先新增交付要求，再分别记录提交和验收。</p>}</section>
    <div className="detail-actions">{item.status === 'draft' && <Button variant="outline" onClick={() => void submit()} disabled={running}>提交审核</Button>}{item.status === 'pending_approval' && canApprove && item.applicantId !== session.actor.memberId && <Button onClick={() => onAction(item, 'decision')}>审批合作</Button>}{['pending_delivery', 'delivered'].includes(item.status) && <Button variant="outline" onClick={() => onAction(item, 'delivery')}><ClipboardCheck size={14} />新增交付</Button>}{item.status === 'pending_samples_receipt' && canApprove && <Button variant="outline" onClick={() => onAction(item, 'waive')}>记录免寄样/免签收</Button>}{!['delivered', 'cancelled', 'rejected'].includes(item.status) && <Button variant="outline" className="button-danger" onClick={() => onAction(item, 'cancel')}>取消合作</Button>}{schedules.length > 0 && <Link className="button button-outline" to="/schedule"><CalendarPlus size={14} />查看排期</Link>}</div>
  </div></Modal>
  {submissionTarget && <DeliveryActionDialog delivery={submissionTarget} kind="submit" open onOpenChange={(value) => { if (!value) setSubmissionTarget(null); }} />}
  {reviewTarget && <DeliveryActionDialog delivery={reviewTarget} kind="review" open onOpenChange={(value) => { if (!value) setReviewTarget(null); }} />}
  </>;
}

function DeliveryActionDialog({ delivery, kind, open, onOpenChange }: { delivery: Delivery; kind: 'submit' | 'review'; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { run, running } = useWorkbench();
  const [decision, setDecision] = useState<'approved' | 'returned'>('approved');
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); const form = new FormData(event.currentTarget);
    try {
      if (kind === 'submit') {
        await run({ type: 'delivery.submit', deliveryId: delivery.id, expectedVersion: delivery.version, submittedAt: new Date().toISOString(), contentUrl: String(form.get('contentUrl') ?? '') || null, platformContentId: String(form.get('platformContentId') ?? '') || null, evidenceUrl: String(form.get('evidenceUrl') ?? '') || null, note: String(form.get('note') ?? '') || null });
        toast.success('交付内容已提交，等待验收');
      } else {
        await run({ type: 'delivery.review', deliveryId: delivery.id, expectedVersion: delivery.version, decision, reviewedAt: new Date().toISOString(), reason: String(form.get('reason') ?? '') || null });
        toast.success(decision === 'approved' ? '交付已验收' : '已退回修改');
      }
      onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败'); }
  }
  return <Modal open={open} onOpenChange={onOpenChange} title={kind === 'submit' ? (delivery.status === 'returned' ? '重新提交交付' : '提交交付') : '验收交付'} description={delivery.title}>
    <form className="modal-form" onSubmit={submit}>
      {kind === 'submit' ? <><FormField label="内容链接"><Input type="url" name="contentUrl" placeholder="https://" /></FormField><FormField label="平台内容 ID"><Input name="platformContentId" /></FormField><FormField label="证据链接"><Input type="url" name="evidenceUrl" placeholder="https://" /></FormField><FormField label="提交说明"><Textarea name="note" rows={3} placeholder="注明发布时间、内容版本或需要验收的要点" /></FormField></> : <><FormField label="验收结果" required><select className="native-select" value={decision} onChange={(event) => setDecision(event.target.value as 'approved' | 'returned')}><option value="approved">验收通过</option><option value="returned">退回修改</option></select></FormField><FormField label="验收说明 / 退回原因" required={decision === 'returned'}><Textarea name="reason" rows={3} required={decision === 'returned'} placeholder={decision === 'returned' ? '说明需要修改的内容和重新提交要求' : '可选填写验收备注'} /></FormField></>}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running}>{running ? '提交中…' : kind === 'submit' ? '提交验收' : '保存验收结果'}</Button></div>
    </form>
  </Modal>;
}

export function CooperationActionDialog({ item, kind, onOpenChange }: { item: Cooperation; kind: 'decision' | 'cancel' | 'waive' | 'delivery'; onOpenChange: (open: boolean) => void }) {
  const { workspace, run, running } = useWorkbench();
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); const form = new FormData(event.currentTarget);
    try {
      if (kind === 'decision') await run({ type: 'cooperation.decide', cooperationId: item.id, expectedVersion: item.version, decision: String(form.get('decision') ?? 'approved') as 'approved' | 'rejected', decidedAt: new Date().toISOString(), reason: String(form.get('reason') ?? '') || null });
      if (kind === 'cancel') await run({ type: 'cooperation.cancel', cooperationId: item.id, expectedVersion: item.version, cancelledAt: new Date().toISOString(), reason: String(form.get('reason') ?? '') });
      if (kind === 'waive') await run({ type: 'cooperation.waiveSamples', cooperationId: item.id, expectedVersion: item.version, waivedAt: new Date().toISOString(), reason: String(form.get('reason') ?? '') });
      if (kind === 'delivery') {
        const scheduleId = String(form.get('scheduleId') ?? '') || null;
        const dueAt = shanghaiInputToIso(String(form.get('dueAt') ?? ''));
        await run({ type: 'delivery.create', cooperationId: item.id, expectedCooperationVersion: item.version, cooperationLineId: String(form.get('cooperationLineId') ?? '') || null, scheduleId, deliveryType: String(form.get('type') ?? 'live') as 'live' | 'short_video' | 'other', title: String(form.get('title') ?? ''), dueAt, required: form.get('required') === 'on' });
      }
      toast.success(kind === 'decision' ? '审批结果已保存' : kind === 'delivery' ? '交付项已创建' : kind === 'cancel' ? '合作单已取消' : '样品要求已更新'); onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败'); }
  }
  const titles = { decision: '审批合作单', cancel: '取消合作', waive: '记录样品豁免', delivery: '新增交付项' };
  return <Modal open onOpenChange={onOpenChange} title={titles[kind]} description={item.title}>
    <form className="modal-form" onSubmit={submit}>
      {kind === 'decision' && <><FormField label="审批结果" required><select className="native-select" name="decision"><option value="approved">通过</option><option value="rejected">驳回</option></select></FormField><FormField label="审批说明 / 驳回原因"><Textarea name="reason" rows={3} placeholder="驳回时须填写原因" /></FormField></>}
      {kind === 'cancel' && <FormField label="取消原因" required><Textarea name="reason" required rows={3} /></FormField>}
      {kind === 'waive' && <FormField label="免寄样 / 免签收原因" required><Textarea name="reason" required rows={3} /></FormField>}
      {kind === 'delivery' && <><FormField label="交付标题" required><Input name="title" required placeholder="例如：品牌专场直播" /></FormField><FormField label="交付类型" required><select className="native-select" name="type"><option value="live">直播</option><option value="short_video">短视频</option><option value="other">其他</option></select></FormField><FormField label="关联商品"><select className="native-select" name="cooperationLineId"><option value="">不限定单个商品</option>{item.lines.map((line) => <option key={line.id} value={line.id}>{line.productName} · {line.sku ?? '无 SKU'}</option>)}</select></FormField><FormField label="关联排期"><select className="native-select" name="scheduleId"><option value="">暂不关联排期</option>{workspace.schedules.filter((schedule) => schedule.cooperationId === item.id).map((schedule) => <option key={schedule.id} value={schedule.id}>{schedule.title} · {formatDateTime(schedule.plannedStartAt)}</option>)}</select></FormField><FormField label="交付截止" required><Input name="dueAt" type="datetime-local" defaultValue={shanghaiDateTimeInput()} required /></FormField><label className="check-row"><input type="checkbox" name="required" defaultChecked />必需交付项</label></>}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" variant={kind === 'cancel' ? 'destructive' : 'default'} disabled={running}>{running ? '提交中…' : '确认'}</Button></div>
    </form>
  </Modal>;
}
