import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Check, ChevronDown, MoreHorizontal, PackagePlus, Plus, Search, Truck } from 'lucide-react';
import type { Platform, SamplePackage, SampleRequest } from '@shared/types';
import { useWorkbench } from '../workbench-context';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '../components/ui/command';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { EmptyState, FormField, Modal, PageHeading, Panel, StatusPill, formatDateTime, shanghaiDateTimeInput, shanghaiInputToIso } from '../components/workbench';
import { isPlatform, platformLabel, type CreatorPlatformFilter } from '../lib/platform-presentation';
import PlatformTabs, { PlatformMark } from '../components/PlatformTabs';
import { selectActionableSamples, selectAwaitingReceiptSamples, selectEligibleSampleCreators, selectPendingApprovalRoster, selectSampleCreatorAccounts, sampleMatchesPlatform } from '../lib/sample-queue';
import { brandScopedHref } from '../lib/home-actions';
import { compareTimestamps } from '../lib/time';
import '../operations-surfaces.css';
import '../sample-workflow.css';

const sampleStatuses = ['draft', 'pending_approval', 'pending_shipment', 'shipped', 'received', 'rejected', 'closed'];
const actionableQueues = ['todo', 'approval', 'shipment', 'receipt'] as const;
type ActionableQueue = (typeof actionableQueues)[number];
type SampleQueueTab = ActionableQueue | 'draft' | 'all';

export default function SamplesPage() {
  const { workspace, session, run, running } = useWorkbench();
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get('q') ?? '';
  const platformValue = searchParams.get('platform') ?? '';
  const platform: CreatorPlatformFilter = isPlatform(platformValue) ? platformValue : 'all';
  const requestedCreatorId = searchParams.get('creatorId') ?? '';
  const createRequested = searchParams.get('create') === '1';
  const canCreate = session.actor.role !== 'ops';
  const eligibleCreators = useMemo(() => selectEligibleSampleCreators({ creators: workspace.creators, actor: session.actor }), [workspace.creators, session.actor.memberId, session.actor.role]);
  const eligibleCreatorIds = useMemo(() => new Set(eligibleCreators.map((creator) => creator.id)), [eligibleCreators]);
  const safeRequestedCreatorId = canCreate && eligibleCreatorIds.has(requestedCreatorId) ? requestedCreatorId : '';
  const requestedStatus = searchParams.get('status');
  const requestedQueue = searchParams.get('queue');
  const queue = actionableQueues.includes(requestedQueue as ActionableQueue) ? requestedQueue as ActionableQueue : null;
  const status = !queue && requestedStatus && ['active', 'all', ...sampleStatuses].includes(requestedStatus) ? requestedStatus : 'active';
  const needsOwnActivityDefault = session.actor.role === 'bd' && !session.actor.capabilities.includes('sample.approve') && !session.actor.capabilities.includes('sample.fulfill');
  const selectedQueue: SampleQueueTab | null = queue ?? (requestedStatus === 'draft' ? 'draft' : requestedStatus === 'all' ? 'all' : !requestedStatus && !needsOwnActivityDefault ? 'todo' : null);
  const statusFilterValue = selectedQueue && selectedQueue !== 'draft' && selectedQueue !== 'all' ? '__queue__' : status;
  const setStatus = (value: string) => {
    const next = new URLSearchParams(searchParams);
    next.delete('queue');
    next.set('status', value);
    setSearchParams(next, { replace: true });
  };
  const setQueue = (value: SampleQueueTab) => {
    if (value === 'draft' || value === 'all') {
      setStatus(value);
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.delete('status');
    next.set('queue', value);
    setSearchParams(next, { replace: true });
  };
  const [createOpen, setCreateOpen] = useState(false);
  const handledCreatorPrefillId = useRef('');
  const [target, setTarget] = useState<SampleRequest | null>(null);
  const [progressTarget, setProgressTarget] = useState<SampleRequest | null>(null);
  const [receiptTarget, setReceiptTarget] = useState<(typeof workspace.samplePackages)[number] | null>(null);
  const [dialog, setDialog] = useState<'decision' | 'package' | 'receipt' | 'close' | null>(null);
  const canApprove = session.actor.capabilities.includes('sample.approve');
  const canFulfill = session.actor.capabilities.includes('sample.fulfill');
  useEffect(() => {
    if (!canCreate) {
      setCreateOpen(false);
      return;
    }
    const creatorPrefillAvailable = requestedCreatorId && eligibleCreatorIds.has(requestedCreatorId);
    if (createRequested) {
      if (creatorPrefillAvailable) handledCreatorPrefillId.current = requestedCreatorId;
      setCreateOpen(true);
      return;
    }
    if (creatorPrefillAvailable && handledCreatorPrefillId.current !== requestedCreatorId) {
      handledCreatorPrefillId.current = requestedCreatorId;
      setCreateOpen(true);
    }
  }, [requestedCreatorId, createRequested, canCreate, eligibleCreatorIds]);

  const searchScopedSamples = useMemo(() => workspace.samples.filter((sample) => {
    if (!sampleMatchesPlatform(sample, platform)) return false;
    const creator = workspace.creators.find((item) => item.id === sample.creatorId);
    if (session.actor.role === 'bd' && sample.applicantId !== session.actor.memberId && creator?.ownerMemberId !== session.actor.memberId) return false;
    const text = [creator?.name, ...(creator?.accounts.flatMap((account) => [account.displayName, account.externalAccountId]) ?? []), sample.id].filter(Boolean).join(' ').toLocaleLowerCase();
    return !query.trim() || text.includes(query.trim().toLowerCase());
  }).sort((a, b) => compareTimestamps(a.createdAt, b.createdAt, 'desc')), [workspace.samples, workspace.creators, session.actor.role, session.actor.memberId, query, platform]);

  const rosterInput = useMemo(() => ({
    samples: searchScopedSamples,
    creators: workspace.creators,
    actor: session.actor,
    teamIds: workspace.scope.teamIds,
  }), [searchScopedSamples, workspace.creators, workspace.scope.teamIds, session.actor]);
  const actionableSamples = useMemo(() => selectActionableSamples({
    samples: searchScopedSamples,
    creators: workspace.creators,
    samplePackages: workspace.samplePackages,
    actor: session.actor,
  }), [searchScopedSamples, workspace.creators, workspace.samplePackages, session.actor]);
  const approvalRoster = useMemo(() => selectPendingApprovalRoster(rosterInput), [rosterInput]);
  const receiptRoster = useMemo(() => selectAwaitingReceiptSamples({ ...rosterInput, samplePackages: workspace.samplePackages }), [rosterInput, workspace.samplePackages]);
  const progressSamples = needsOwnActivityDefault ? searchScopedSamples : actionableSamples;
  const queueCounts = {
    todo: actionableSamples.length,
    approval: approvalRoster.length,
    shipment: progressSamples.filter((sample) => sample.status === 'pending_shipment').length,
    receipt: receiptRoster.length,
    draft: searchScopedSamples.filter((sample) => sample.status === 'draft').length,
    all: searchScopedSamples.length,
  };
  const samples = useMemo(() => {
    if (selectedQueue === 'todo') return actionableSamples;
    if (selectedQueue === 'approval' || status === 'pending_approval') return approvalRoster;
    if (selectedQueue === 'shipment') return progressSamples.filter((sample) => sample.status === 'pending_shipment');
    if (selectedQueue === 'receipt') return receiptRoster;
    if (selectedQueue === 'draft') return searchScopedSamples.filter((sample) => sample.status === 'draft');
    if (selectedQueue === 'all' || status === 'all') return searchScopedSamples;
    if (status === 'active') return searchScopedSamples.filter((sample) => !['received', 'rejected', 'closed'].includes(sample.status));
    return searchScopedSamples.filter((sample) => sample.status === status);
  }, [selectedQueue, actionableSamples, approvalRoster, receiptRoster, progressSamples, searchScopedSamples, status]);

  function openAction(sample: SampleRequest, action: 'decision' | 'package' | 'close') { setTarget(sample); setDialog(action); }
  function changeQuery(value: string) { const next = new URLSearchParams(searchParams); if (value) next.set('q', value); else next.delete('q'); setSearchParams(next, { replace: true }); }
  function changeCreateOpen(open: boolean, created = false, submittedPlatform?: Platform) {
    setCreateOpen(open);
    if (open) return;
    const next = new URLSearchParams(searchParams);
    next.delete('create');
    next.delete('creatorId');
    next.delete('accountId');
    if (created) {
      next.delete('queue');
      next.set('status', 'pending_shipment');
      if (submittedPlatform) next.set('platform', submittedPlatform);
    }
    setSearchParams(next, { replace: true });
  }
  function requestCreate() {
    if (!canCreate) return;
    const next = new URLSearchParams(searchParams);
    next.set('create', '1');
    setSearchParams(next, { replace: true });
  }
  async function submitSample(sample: SampleRequest) {
    try { await run({ type: 'sample.submit', sampleId: sample.id, expectedVersion: sample.version, submittedAt: new Date().toISOString() }); toast.success('样品申请已提交审核'); }
    catch (error) { toast.error(error instanceof Error ? error.message : '提交失败'); }
  }
  function openReceipt(sample: SampleRequest, pack: (typeof workspace.samplePackages)[number]) { setTarget(sample); setReceiptTarget(pack); setDialog('receipt'); }

  return <div className="page-stack ops-page ops-page--samples">
    <PageHeading title="寄样" actions={canCreate && <Button onClick={requestCreate}><Plus size={15} />申请寄样</Button>} />
    <PlatformTabs value={platform} onChange={(value) => { const next = new URLSearchParams(searchParams); if (value === 'all') next.delete('platform'); else next.set('platform', value); setSearchParams(next, { replace: true }); }} variant="pill" label="按平台筛选寄样" />
    <Panel title="寄样记录">
      <nav className="sample-queue-tabs tab-row" role="group" aria-label="样品申请队列">
        {!needsOwnActivityDefault && <QueueTab label="待处理" value="todo" count={queueCounts.todo} selected={selectedQueue === 'todo'} onSelect={setQueue} />}
        {(!needsOwnActivityDefault || queueCounts.approval > 0 || selectedQueue === 'approval') && <QueueTab label="待审核" value="approval" count={queueCounts.approval} selected={selectedQueue === 'approval'} onSelect={setQueue} />}
        <QueueTab label="待发货" value="shipment" count={queueCounts.shipment} selected={selectedQueue === 'shipment'} onSelect={setQueue} />
        <QueueTab label="待签收" value="receipt" count={queueCounts.receipt} selected={selectedQueue === 'receipt'} onSelect={setQueue} />
        {(queueCounts.draft > 0 || selectedQueue === 'draft') && <QueueTab label="草稿" value="draft" count={queueCounts.draft} selected={selectedQueue === 'draft'} onSelect={setQueue} />}
        <QueueTab label="全部" value="all" count={queueCounts.all} selected={selectedQueue === 'all'} onSelect={setQueue} />
        <Link className="tab-button sample-queue-tab" to={brandScopedHref('/source-records/samples', searchParams.get('brandId') ?? undefined)}>寄样历史</Link>
      </nav>
      <div className="toolbar">
        <label className="search-field"><Search size={14} /><input value={query} onChange={(event) => changeQuery(event.target.value)} placeholder="搜索达人名称或账号" aria-label="搜索样品申请" /></label>
        <select className="filter-select" value={statusFilterValue} onChange={(event) => { if (event.target.value !== '__queue__') setStatus(event.target.value); }} aria-label="按状态筛选"><option value="__queue__" disabled>更多状态</option><option value="active">进行中</option><option value="all">全部状态</option>{sampleStatuses.map((value) => <option key={value} value={value}>{sampleLabel(value)}</option>)}</select>
        <span className="toolbar-spacer" /><span className="table-result-count">{samples.length} 条申请</span>
      </div>
      {samples.length === 0 ? <EmptyState title={searchScopedSamples.length ? '没有符合条件的申请' : '还没有样品申请'} description={searchScopedSamples.length ? '调整搜索词或切换队列。' : '先选定达人和要寄的商品。以前登记的记录在「寄样历史」。'} action={<span className="sample-empty-actions">{canCreate && <Button size="sm" variant="outline" onClick={requestCreate}><Plus size={14} />新建申请</Button>}<Link className="button button-outline" to={brandScopedHref('/source-records/samples', searchParams.get('brandId') ?? undefined)}>寄样历史</Link></span>} /> : (
        <div className="table-wrap"><table className="data-table sample-table"><thead><tr><th>达人</th><th>商品</th><th>申请人</th><th>状态</th><th>物流</th><th>申请时间</th><th className="text-right">操作</th></tr></thead><tbody>
          {samples.map((sample) => {
            const creator = workspace.creators.find((item) => item.id === sample.creatorId);
            const applicant = workspace.members.find((member) => member.id === sample.applicantId);
            const packages = workspace.samplePackages.filter((pack) => pack.sampleId === sample.id);
            const requestedAccount = creator?.accounts.find((account) => account.id === sample.creatorAccountId);
            const label = requestedAccount?.displayName ?? creator?.accounts[0]?.displayName ?? creator?.name ?? `寄样申请 ${sample.id.slice(-8)}`;
            return <tr key={sample.id}><td data-label="达人"><span className="table-primary">{label}</span>{sample.platform && <span className="table-secondary">{platformLabel(sample.platform)}</span>}</td><td data-label="商品">{sample.lines.map((line) => { const product = workspace.products.find((item) => item.id === line.productId); return <span key={line.id} className="table-secondary product-line">{product?.name ?? '商品已归档'} × {line.quantity}</span>; })}</td><td className="sample-desktop-cell" data-label="申请人">{applicant?.displayName ?? '—'}</td><td data-label="状态"><StatusPill value={sample.status} label={sampleLabel(sample.status)} /></td><td className="sample-desktop-cell" data-label="物流">{packages.length ? <>{packages.slice(0, 2).map((pack) => <span className="table-primary" key={pack.id}>{pack.carrier} · {pack.trackingNumber}</span>)}<span className="table-secondary">{packages.filter((pack) => pack.receivedAt).length}/{packages.length} 已签收{packages.length > 2 ? ` · 另有 ${packages.length - 2} 个包裹` : ''}</span></> : <span className="text-muted">未发货</span>}{packages.length > 0 && <button type="button" className="link-button sample-progress-link" onClick={() => setProgressTarget(sample)}>物流进度</button>}</td><td className="sample-desktop-cell" data-label="申请时间">{formatDateTime(sample.createdAt)}</td><td className="table-action-cell" data-label="操作"><div className="inline-actions">
              {sample.status === 'pending_approval' && canApprove && sample.applicantId !== session.actor.memberId && <Button variant="outline" size="sm" className="small-button" onClick={() => openAction(sample, 'decision')} disabled={running}>审核申请</Button>}
              {sample.status === 'pending_shipment' && canFulfill && <Button variant="outline" size="sm" className="small-button" onClick={() => openAction(sample, 'package')} disabled={running}><PackagePlus size={13} />登记发货</Button>}
              {['pending_shipment', 'shipped'].includes(sample.status) && canFulfill && packages.some((pack) => !pack.receivedAt) && <Button variant="outline" size="sm" className="small-button" onClick={() => openReceipt(sample, packages.find((pack) => !pack.receivedAt)!)} disabled={running}><Check size={13} />确认签收</Button>}
              {sample.status === 'draft' && <Button variant="outline" size="sm" className="small-button" onClick={() => void submitSample(sample)} disabled={running}>提交审核</Button>}
              {['draft', 'pending_approval', 'pending_shipment'].includes(sample.status) && session.actor.role !== 'ops' && <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="sample-more-button" aria-label={`申请 ${sample.id.slice(-8)} 更多操作`}><MoreHorizontal size={16} /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem variant="destructive" onSelect={() => openAction(sample, 'close')}>关闭申请</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}
            </div></td></tr>;
          })}
        </tbody></table></div>
      )}
    </Panel>
    <CreateSampleDialog key={`${safeRequestedCreatorId}:${searchParams.get('accountId') ?? ''}`} open={createOpen} onOpenChange={changeCreateOpen} initialCreatorId={safeRequestedCreatorId} initialAccountId={searchParams.get('accountId') ?? ''} initialPlatform={platform} />
    {progressTarget && <SampleProgressDialog sample={workspace.samples.find((item) => item.id === progressTarget.id) ?? progressTarget} onClose={() => setProgressTarget(null)} />}
    {target && <SampleActionDialog sample={target} packageItem={receiptTarget} kind={dialog} onOpenChange={(open) => { if (!open) { setDialog(null); setReceiptTarget(null); } }} />}
  </div>;
}

function sampleLabel(status: string) { return ({ draft: '草稿', pending_approval: '待审核', pending_shipment: '待发货', shipped: '已发货', received: '已签收', rejected: '已驳回', closed: '已关闭' } as Record<string, string>)[status] ?? status; }

function QueueTab({ label, value, count, selected, onSelect }: { label: string; value: SampleQueueTab; count: number; selected: boolean; onSelect: (value: SampleQueueTab) => void }) {
  return <button type="button" aria-pressed={selected} className="tab-button sample-queue-tab" onClick={() => onSelect(value)}>{label}<span className="count-badge">{count}</span></button>;
}

function CreateSampleDialog({ open, onOpenChange, initialCreatorId = '', initialAccountId = '', initialPlatform = 'all' }: {
  open: boolean;
  onOpenChange: (open: boolean, created?: boolean, submittedPlatform?: Platform) => void;
  initialCreatorId?: string;
  initialAccountId?: string;
  initialPlatform?: CreatorPlatformFilter;
}) {
  const { workspace, session, run, running } = useWorkbench();
  const [searchParams] = useSearchParams();
  const allOptions = useMemo(() => selectSampleCreatorAccounts({ creators: workspace.creators, actor: workspace.actor, platform: 'all' }), [workspace.creators, workspace.actor.memberId, workspace.actor.role]);
  const requestedOptions = allOptions.filter(({ creator, account }) => creator.id === initialCreatorId
    && (!initialAccountId || account.id === initialAccountId)
    && (initialPlatform === 'all' || account.platform === initialPlatform));
  const prefilledAccountId = requestedOptions.length === 1 ? requestedOptions[0].account.id : '';
  const [formPlatform, setFormPlatform] = useState<CreatorPlatformFilter>(initialPlatform);
  const [accountId, setAccountId] = useState(prefilledAccountId);
  const [creatorPickerOpen, setCreatorPickerOpen] = useState(false);
  const options = allOptions.filter(({ account }) => formPlatform === 'all' || account.platform === formPlatform);
  const selected = options.find(({ account }) => account.id === accountId);
  const [lines, setLines] = useState<Array<{ productId: string; quantity: number }>>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    setFormPlatform(initialPlatform);
    setAccountId(prefilledAccountId);
    setLines([]);
    setError('');
  }, [open, initialPlatform, prefilledAccountId]);
  const availableProducts = workspace.products.filter((product) => product.active);
  const canManageProducts = session.actor.role === 'manager' || session.actor.role === 'admin';
  const brandId = session.businessWorkspace?.brandId ?? session.workbook?.brandId ?? searchParams.get('brandId') ?? undefined;
  const createCreatorHref = brandScopedHref(`/creators?create=1&platform=${formPlatform}`, brandId);
  const catalogPlatform = selected?.account.platform ?? (formPlatform === 'all' ? 'douyin' : formPlatform);
  const createProductHref = brandScopedHref(`/products?create=1&platform=${catalogPlatform}`, brandId);
  function addLine() {
    const product = availableProducts.find((item) => !lines.some((line) => line.productId === item.id));
    if (product) setLines((current) => [...current, { productId: product.id, quantity: 1 }]);
  }
  function updateLine(index: number, patch: Partial<{ productId: string; quantity: number }>) {
    setLines((current) => current.map((line, i) => i === index ? { ...line, ...patch } : line));
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    if (!selected) { setError('请先选择已录入的达人及平台账号。'); return; }
    try {
      await run({
        type: 'sample.request', creatorId: selected.creator.id, creatorAccountId: selected.account.id,
        expectedCreatorVersion: selected.creator.version, cooperationId: null, lines,
        recipient: { recipientName: String(form.get('recipientName') ?? ''), phone: String(form.get('phone') ?? '') || null, address: String(form.get('address') ?? '') },
        reason: String(form.get('reason') ?? ''), originalRequestId: null,
      });
      toast.success('寄样申请已提交，等待供应链寄送');
      onOpenChange(false, true, selected.account.platform);
      setLines([]);
      setAccountId('');
      formElement.reset();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '提交失败'); }
  }
  const totalQuantity = lines.reduce((sum, line) => sum + line.quantity, 0);
  return <Modal open={open} onOpenChange={onOpenChange} title="申请寄样" description="提交后进入待寄送队列，供应链同学寄出后回填快递单号。" className="modal-standard modal-wide sample-workflow-dialog">
    <form className="modal-form sample-workflow-form" onSubmit={submit}>
      <div className="sample-workflow-form-body">
        <section className="sample-form-section" aria-labelledby="sample-recipient-title">
          <div className="sample-form-section-heading"><div><h3 id="sample-recipient-title">达人与收件</h3><p>仅能选择已录入且有权申请寄样的达人。</p></div></div>
          <PlatformTabs value={formPlatform} label="申样达人平台" onChange={(value) => { setFormPlatform(value); setAccountId(''); }} variant="pill" />
          <div className="form-grid">
            <div className="form-field sample-creator-field span-2"><span className="field-label">达人账号<b aria-hidden="true"> *</b></span>
              <Popover open={creatorPickerOpen} onOpenChange={setCreatorPickerOpen}>
                <PopoverTrigger asChild><Button type="button" variant="outline" className="sample-creator-trigger" aria-expanded={creatorPickerOpen} aria-label="搜索并选择已录入达人"><span>{selected ? `${selected.account.displayName} · ${platformLabel(selected.account.platform)}` : '搜索已录入达人、昵称或平台账号 ID'}</span><ChevronDown size={15} aria-hidden="true" /></Button></PopoverTrigger>
                <PopoverContent align="start" className="sample-creator-popover">
                  <Command filter={(value, search) => search.trim().toLocaleLowerCase().split(/\s+/u).every((part) => value.toLocaleLowerCase().includes(part)) ? 1 : 0}>
                    <CommandInput placeholder="搜索达人、昵称或账号 ID" />
                    <CommandList><CommandEmpty>没有匹配的已录入达人，请先在达人里录入。</CommandEmpty><CommandGroup>{options.map(({ creator, account }) => <CommandItem key={account.id} value={`${creator.name} ${account.displayName} ${account.externalAccountId} ${platformLabel(account.platform)}`} onSelect={() => { setAccountId(account.id); setCreatorPickerOpen(false); }}>
                      <Check size={14} className={account.id === accountId ? 'sample-creator-selected' : 'sample-creator-unselected'} />
                      <PlatformMark platform={account.platform} />
                      <span className="sample-creator-option"><strong>{account.displayName}</strong><small>{platformLabel(account.platform)} · {account.externalAccountId}</small></span>
                    </CommandItem>)}</CommandGroup></CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              {selected && <small className="sample-creator-selected-summary">{selected.creator.name} · {platformLabel(selected.account.platform)} · {selected.account.externalAccountId}</small>}
              <div className="sample-recorded-creator-help"><span>找不到达人？</span><Link to={createCreatorHref} onClick={() => onOpenChange(false)}>先录入达人</Link></div>
            </div>
            <FormField label="收件人" required><Input name="recipientName" required /></FormField>
            <FormField label="联系电话"><Input name="phone" inputMode="tel" /></FormField>
            <FormField label="收件地址" required className="span-2"><Textarea name="address" rows={2} required /></FormField>
          </div>
        </section>
        <section className="sample-form-section" aria-labelledby="sample-products-title">
          <div className="sample-form-section-heading sample-products-heading"><div><h3 id="sample-products-title">寄送商品</h3><p>按商品件数填写，可分包寄出。</p></div><Button type="button" variant="outline" size="sm" onClick={addLine} disabled={!availableProducts.some((product) => !lines.some((line) => line.productId === product.id))}><Plus size={14} />添加商品</Button></div>
          {lines.length ? <div className="sample-line-table"><div className="sample-line-header"><span>商品</span><span>数量</span><span>操作</span></div><div className="line-items-list">{lines.map((line, index) => <div className="line-item-row sample-line-item" key={`${line.productId}-${index}`}><select className="native-select" value={line.productId} onChange={(event) => updateLine(index, { productId: event.target.value })} aria-label={`第 ${index + 1} 个商品`} required>{availableProducts.map((product) => <option key={product.id} value={product.id}>{product.brand} · {product.name}{product.sku ? ` · ${product.sku}` : ''}</option>)}</select><Input type="number" min={1} step={1} value={line.quantity} onChange={(event) => updateLine(index, { quantity: Number(event.target.value) })} aria-label="申请数量" required /><button className="link-button button-danger" type="button" onClick={() => setLines((current) => current.filter((_, i) => i !== index))}>移除</button></div>)}</div><div className="sample-line-total">共 {lines.length} 个商品 · {totalQuantity} 件</div></div> : availableProducts.length ? <div className="line-items-empty">请添加至少一个商品。</div> : <div className="line-items-empty sample-no-products"><span>还没有可寄送商品。</span>{canManageProducts ? <Link to={createProductHref}>去添加商品</Link> : <span>请联系管理员录入商品。</span>}</div>}
        </section>
        <section className="sample-form-section" aria-labelledby="sample-reason-title">
          <div className="sample-form-section-heading"><div><h3 id="sample-reason-title">寄样说明</h3><p>写明样品用途或与达人的约定，方便供应链处理。</p></div></div>
          <FormField label="寄样说明" required><Textarea name="reason" rows={3} required placeholder="填写样品用途或本次沟通约定" /></FormField>
        </section>
        {error && <p className="field-error" role="alert">{error}</p>}
      </div>
      <div className="modal-actions sample-workflow-footer"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running || !selected || !lines.length}>{running ? '提交中…' : '提交寄样申请'}</Button></div>
    </form>
  </Modal>;
}

function SampleProgressDialog({ sample, onClose }: { sample: SampleRequest; onClose: () => void }) {
  const { workspace } = useWorkbench();
  const packages = workspace.samplePackages.filter((item) => item.sampleId === sample.id);
  return <Modal open onOpenChange={(open) => { if (!open) onClose(); }} title="寄样进度" description="快递单号与签收状态由供应链登记。">
    <div className="sample-progress-summary"><StatusPill value={sample.status} label={sampleLabel(sample.status)} /><span>申请时间：{formatDateTime(sample.createdAt)}</span></div>
    {packages.length ? <div className="sample-progress-packages">{packages.map((pack, index) => <section key={pack.id}>
      <div><strong>包裹 {index + 1}</strong><StatusPill value={pack.receivedAt ? 'received' : 'shipped'} label={pack.receivedAt ? '已签收' : '已寄出'} /></div>
      <p>{pack.carrier} · {pack.trackingNumber}</p>
      <small>寄出：{formatDateTime(pack.shippedAt)}{pack.receivedAt ? ` · 签收：${formatDateTime(pack.receivedAt)}` : ''}</small>
      <p className="text-muted">{pack.lines.map((line) => {
        const sampleLine = sample.lines.find((item) => item.id === line.sampleLineId);
        const product = workspace.products.find((item) => item.id === sampleLine?.productId);
        return `${product?.name ?? '商品'} × ${line.quantity}`;
      }).join('、')}</p>
    </section>)}</div> : <EmptyState title="暂无寄送记录" description={sample.status === 'pending_shipment' ? '供应链寄出并登记单号后，这里会显示包裹信息。' : '当前申请还没有登记发货包裹。'} />}
    <div className="modal-actions"><Button type="button" variant="outline" onClick={onClose}>返回列表</Button></div>
  </Modal>;
}

function SampleActionDialog({ sample, packageItem, kind, onOpenChange }: { sample: SampleRequest; packageItem: SamplePackage | null; kind: 'decision' | 'package' | 'receipt' | 'close' | null; onOpenChange: (open: boolean) => void }) {
  const { workspace, run, running } = useWorkbench();
  const [error, setError] = useState('');
  const shippedByLine = useMemo(() => workspace.samplePackages.filter((pack) => pack.sampleId === sample.id).flatMap((pack) => pack.lines).reduce<Record<string, number>>((result, line) => ({ ...result, [line.sampleLineId]: (result[line.sampleLineId] ?? 0) + line.quantity }), {}), [workspace.samplePackages, sample.id]);
  const [packageQuantities, setPackageQuantities] = useState<Record<string, number>>({});
  useEffect(() => {
    setPackageQuantities(Object.fromEntries(sample.lines.map((line) => [line.id, Math.max(0, line.quantity - (shippedByLine[line.id] ?? 0))])));
  }, [sample.id, sample.lines, shippedByLine]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); const form = new FormData(event.currentTarget);
    try {
      if (kind === 'decision') {
        await run({ type: 'sample.decide', sampleId: sample.id, expectedVersion: sample.version, decision: String(form.get('decision') ?? 'approved') as 'approved' | 'rejected', decidedAt: new Date().toISOString(), reason: String(form.get('reason') ?? '') || null });
        toast.success('审核结果已保存');
      } else if (kind === 'package') {
        const packageLines = sample.lines.flatMap((line) => packageQuantities[line.id] > 0 ? [{ sampleLineId: line.id, productId: line.productId, quantity: packageQuantities[line.id] }] : []);
        if (!packageLines.length) { setError('请为本包裹填写至少一项商品数量。'); return; }
        await run({ type: 'sample.addPackage', sampleId: sample.id, expectedVersion: sample.version, carrier: String(form.get('carrier') ?? ''), trackingNumber: String(form.get('trackingNumber') ?? ''), lines: packageLines, shippedAt: shanghaiInputToIso(String(form.get('shippedAt') ?? '')) });
        toast.success('包裹已登记');
      } else if (kind === 'receipt') {
        if (!packageItem) { setError('没有找到待签收的包裹，请刷新后重试。'); return; }
        await run({ type: 'sample.confirmReceipt', sampleId: sample.id, expectedSampleVersion: sample.version, packageId: packageItem.id, expectedPackageVersion: packageItem.version, receivedAt: shanghaiInputToIso(String(form.get('receivedAt') ?? '')), evidenceUrl: String(form.get('evidenceUrl') ?? '') || null });
        toast.success('包裹签收记录已保存');
      } else if (kind === 'close') {
        await run({ type: 'sample.close', sampleId: sample.id, expectedVersion: sample.version, closedAt: new Date().toISOString(), reason: String(form.get('reason') ?? '') });
        toast.success('申请已关闭');
      }
      onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败'); }
  }
  if (!kind) return null;
  const title = kind === 'decision' ? '审核样品申请' : kind === 'package' ? '登记发货包裹' : kind === 'receipt' ? '确认包裹签收' : '关闭样品申请';
  return <Modal open={Boolean(kind)} onOpenChange={onOpenChange} title={title} description={`申请 …${sample.id.slice(-10)} · ${sample.lines.length} 个商品行`}>
    <form className="modal-form" onSubmit={submit}>
      {(kind === 'decision' || kind === 'package') && <section className="detail-section">
        <h3>申请与收件信息</h3>
        <p className="detail-note">{sample.reason}</p>
        {sample.recipient ? <>
          <p className="detail-note">{sample.recipient.recipientName}{sample.recipient.phone ? ` · ${sample.recipient.phone}` : ''}</p>
          <p className="detail-note">{sample.recipient.address}</p>
        </> : <p className="detail-note">暂无收件信息。</p>}
      </section>}
      {kind === 'decision' && <><FormField label="审核结果" required><select name="decision" className="native-select"><option value="approved">通过，进入待发货</option><option value="rejected">驳回</option></select></FormField><FormField label="审核说明 / 驳回原因"><Textarea name="reason" rows={3} placeholder="驳回时必须填写原因" /></FormField></>}
      {kind === 'package' && <><FormField label="承运方" required><Input name="carrier" required placeholder="例如：顺丰" /></FormField><FormField label="物流单号" required><Input name="trackingNumber" required /></FormField><FormField label="发货时间" required><Input name="shippedAt" type="datetime-local" defaultValue={shanghaiDateTimeInput()} required /></FormField><div className="package-lines">{sample.lines.map((line) => { const product = workspace.products.find((item) => item.id === line.productId); const remaining = Math.max(0, line.quantity - (shippedByLine[line.id] ?? 0)); return <div className="package-line" key={line.id}><span>{product?.name ?? '商品'}<small>剩余待发 {remaining}</small></span><Input type="number" min={0} max={remaining} value={packageQuantities[line.id] ?? 0} onChange={(event) => setPackageQuantities((current) => ({ ...current, [line.id]: Math.min(remaining, Math.max(0, Number(event.target.value))) }))} aria-label={`${product?.name ?? '商品'}本包裹数量`} disabled={remaining === 0} /></div>; })}</div><div className="notice notice-info"><Truck size={15} /> 本次可只发部分数量；未发商品保留在申请中，后续可以继续登记包裹。</div></>}
      {kind === 'receipt' && <><div className="notice notice-info"><Truck size={15} /> {packageItem?.carrier ?? '承运方'} · 单号 {packageItem?.trackingNumber ?? '—'}</div><FormField label="签收时间" required><Input name="receivedAt" type="datetime-local" defaultValue={shanghaiDateTimeInput()} required /></FormField><FormField label="签收凭证链接"><Input name="evidenceUrl" type="url" placeholder="https://" /></FormField></>}
      {kind === 'close' && <FormField label="关闭原因" required><Textarea name="reason" rows={3} required placeholder="关闭后保留原申请、审批和物流历史" /></FormField>}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>返回</Button><Button type="submit" variant={kind === 'close' ? 'destructive' : 'default'} disabled={running}>{running ? '提交中…' : kind === 'decision' ? '保存审核结果' : kind === 'package' ? '确认发货' : kind === 'receipt' ? '确认签收' : '确认关闭'}</Button></div>
    </form>
  </Modal>;
}
