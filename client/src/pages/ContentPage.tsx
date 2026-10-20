import { useMemo, useState, type FormEvent } from 'react';
import '../operations-surfaces.css';
import { toast } from 'sonner';
import { ClipboardList, ExternalLink, FileVideo2, Plus, Search } from 'lucide-react';
import type { ContentAssetType, ContentAssetWorkspaceItem, ContentObservation, ContentRightScope, ContentRightsStatus, Delivery } from '@shared/types';
import { useWorkbench } from '../workbench-context';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { EmptyState, FormField, formatDateTime, formatMoney, Modal, PageHeading, Panel, StatusPill, shanghaiDateTimeInput, shanghaiInputToIso } from '../components/workbench';
import { canManageBusiness, parseNonnegativeCents, parseNonnegativeInteger, rightsPresentation, splitTags } from '../lib/business-ui';

const typeLabels: Record<ContentAssetType, string> = { short_video: '短视频', live: '直播', live_replay: '直播回放', image: '图片', script: '脚本', other: '其他' };
const rightScopeLabels: Record<ContentRightScope, string> = { publish: '品牌发布', edit: '剪辑改编', paid_media: '付费投流' };
const rightsLabels: Record<ContentRightsStatus, string> = { unknown: '授权未核实', pending: '待授权', authorized: '已授权', revoked: '已撤回' };

export default function ContentPage() {
  const { session, workspace } = useWorkbench();
  const canManage = canManageBusiness(session.actor.role);
  const canUseContent = canManage || session.actor.role === 'bd';
  const availableCreators = workspace.creators.filter((creator) => canManage || creator.ownerMemberId === session.actor.memberId);
  const registeredDeliveryIds = new Set(workspace.contentAssets.map((asset) => asset.deliveryId).filter((id): id is string => Boolean(id)));
  const accessibleApprovedDeliveries = workspace.deliveries.filter((delivery) => delivery.status === 'approved' && (canManage || (delivery.ownerMemberId === session.actor.memberId && availableCreators.some((creator) => creator.id === delivery.creatorId))));
  const eligibleDeliveries = accessibleApprovedDeliveries.filter((delivery) => !registeredDeliveryIds.has(delivery.id) && approvedDeliverySourceUrl(delivery));
  const acceptedDeliveriesMissingLink = accessibleApprovedDeliveries.filter((delivery) => !registeredDeliveryIds.has(delivery.id) && !approvedDeliverySourceUrl(delivery));
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | ContentAssetType>('all');
  const [rightsFilter, setRightsFilter] = useState<'all' | ContentRightsStatus>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [registerDeliveryOpen, setRegisterDeliveryOpen] = useState(false);
  const [selected, setSelected] = useState<ContentAssetWorkspaceItem | null>(null);
  const [editing, setEditing] = useState<ContentAssetWorkspaceItem | null>(null);
  const [updatingRights, setUpdatingRights] = useState<ContentAssetWorkspaceItem | null>(null);
  const [observing, setObserving] = useState<ContentAssetWorkspaceItem | null>(null);
  const assets = canUseContent ? workspace.contentAssets : [];
  const visible = assets.filter((asset) => {
    const matchesType = typeFilter === 'all' || asset.type === typeFilter;
    const matchesRights = rightsFilter === 'all' || asset.rightsStatus === rightsFilter;
    const creator = workspace.creators.find((item) => item.id === asset.creatorId);
    const products = asset.productIds.map((id) => workspace.products.find((item) => item.id === id)?.name ?? '').join(' ');
    const haystack = `${asset.title} ${asset.tags.join(' ')} ${creator?.name ?? ''} ${products}`.toLocaleLowerCase();
    return matchesType && matchesRights && haystack.includes(query.trim().toLocaleLowerCase());
  });
  const expiredCount = assets.filter((asset) => rightsPresentation(asset).label === '授权已过期').length;
  const effectiveCount = assets.filter((asset) => rightsPresentation(asset).label === '授权生效中').length;
  const pendingCount = assets.filter((asset) => ['授权未核实', '待授权', '未来生效', '当前无效'].includes(rightsPresentation(asset).label)).length;
  const sortedObservations = useMemo(() => [...workspace.contentObservations].sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt)), [workspace.contentObservations]);
  const currentSelected = selected ? assets.find((asset) => asset.id === selected.id) : undefined;
  const currentEditing = editing ? assets.find((asset) => asset.id === editing.id) : undefined;
  const currentRightsAsset = updatingRights ? assets.find((asset) => asset.id === updatingRights.id) : undefined;
  const currentObservationAsset = observing ? assets.find((asset) => asset.id === observing.id) : undefined;

  return <div className="page-stack ops-page ops-page--content">
    <PageHeading title="内容资产库" description="管理内容、授权和表现数据。" actions={canUseContent && <><Button variant="outline" onClick={() => setCreateOpen(true)} disabled={!availableCreators.length}><Plus size={15} />手工登记</Button><Button onClick={() => setRegisterDeliveryOpen(true)} disabled={!eligibleDeliveries.length}><FileVideo2 size={15} />从已验收交付登记</Button></>} />
    {canUseContent && <div className="page-grid metrics-grid"><div className="small-metric"><span>内容条数</span><strong>{assets.length}</strong></div><div className="small-metric"><span>授权生效中</span><strong>{effectiveCount}</strong></div><div className="small-metric"><span>授权已过期</span><strong>{expiredCount}</strong></div><div className="small-metric"><span>待核验 / 未生效</span><strong>{pendingCount}</strong></div></div>}
    <Panel title="内容清单" description="发布、改编或投放前，请确认内容已获对应授权且仍在有效期内。">
      <div className="toolbar">
        <label className="search-field"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索内容、达人、商品或标签" aria-label="搜索内容资产" /></label>
        <label className="date-filter-label">内容类型<select className="native-select" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as typeof typeFilter)} aria-label="按内容类型筛选"><option value="all">全部类型</option>{Object.entries(typeLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="date-filter-label">授权状态<select className="native-select" value={rightsFilter} onChange={(event) => setRightsFilter(event.target.value as typeof rightsFilter)} aria-label="按授权状态筛选"><option value="all">全部状态</option>{Object.entries(rightsLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <span className="toolbar-spacer" /><span className="table-result-count">{visible.length} 条资产</span>
      </div>
      {acceptedDeliveriesMissingLink.length > 0 && <div className="notice notice-warning"><FileVideo2 size={14} /><span>{acceptedDeliveriesMissingLink.length} 条已验收交付缺少内容链接，请补齐后再登记；其他内容可手工登记。</span></div>}
      {visible.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>内容 / 达人</th><th>类型 / 商品</th><th>标签</th><th>授权</th><th>表现记录</th><th className="text-right">操作</th></tr></thead><tbody>{visible.map((asset) => {
        const creator = workspace.creators.find((item) => item.id === asset.creatorId);
        const productNames = asset.productIds.map((id) => workspace.products.find((item) => item.id === id)?.name).filter((name): name is string => Boolean(name));
        const observations = sortedObservations.filter((observation) => observation.contentAssetId === asset.id);
        const rights = rightsPresentation(asset);
        return <tr key={asset.id}>
          <td><button type="button" className="link-button table-primary" onClick={() => setSelected(asset)}>{asset.title}</button><span className="table-secondary">{creator?.name ?? '达人信息暂不可用'} · {asset.deliveryId ? '验收交付' : '手工登记'}</span></td>
          <td>{typeLabels[asset.type]}<span className="table-secondary">{productNames.length ? productNames.join('、') : '未关联商品'}</span></td>
          <td><div className="tag-list">{asset.tags.length ? asset.tags.slice(0, 3).map((tag) => <span className="tag-chip" key={tag}>{tag}</span>) : <span className="text-muted">暂无标签</span>}{asset.tags.length > 3 && <span className="tag-chip">+{asset.tags.length - 3}</span>}</div></td>
          <td><StatusPill value={asset.rightsStatus} label={rights.label} tone={rights.tone} /><span className="table-secondary">{rights.activeScopes.map((scope) => rightScopeLabels[scope]).join('、') || '当前无生效范围'}</span></td>
          <td>{observations.length ? <span className="table-primary">{observations.length} 条记录</span> : <span className="text-muted">未记录</span>}</td>
          <td className="table-action-cell"><div className="inline-actions"><Button variant="outline" size="sm" className="small-button" onClick={() => setSelected(asset)}>查看</Button>{canUseContent && <Button variant="outline" size="sm" className="small-button" onClick={() => setObserving(asset)}>记表现</Button>}</div></td>
        </tr>;
      })}</tbody></table></div> : <EmptyState title={!canUseContent ? '暂无法查看内容资产' : query || typeFilter !== 'all' || rightsFilter !== 'all' ? '没有匹配内容' : '内容资产库为空'} description={!canUseContent ? '请联系管理员开通查看权限。' : query || typeFilter !== 'all' || rightsFilter !== 'all' ? '调整搜索词或筛选条件后重试。' : '可手工登记内容，或从已验收交付中登记。'} icon={<ClipboardList size={21} />} action={canUseContent && !query && <div className="inline-actions"><Button size="sm" variant="outline" onClick={() => setCreateOpen(true)} disabled={!availableCreators.length}><Plus size={14} />手工登记</Button><Button size="sm" onClick={() => setRegisterDeliveryOpen(true)} disabled={!eligibleDeliveries.length}>登记已验收交付</Button></div>} />}
    </Panel>
    {canUseContent && createOpen && <ContentAssetDialog key={`${session.actor.memberId}:${session.actor.role}:manual`} mode="manual" creators={availableCreators} open onOpenChange={setCreateOpen} />}
    {canUseContent && registerDeliveryOpen && eligibleDeliveries.length > 0 && <ContentAssetDialog key={`${session.actor.memberId}:${session.actor.role}:delivery`} mode="delivery" deliveries={eligibleDeliveries} creators={availableCreators} open onOpenChange={setRegisterDeliveryOpen} />}
    {canUseContent && selected && currentSelected && <ContentDetail asset={currentSelected} observations={sortedObservations.filter((observation) => observation.contentAssetId === currentSelected.id)} open onOpenChange={(open) => { if (!open) setSelected(null); }} canUseContent={canUseContent} onEdit={() => { setEditing(currentSelected); setSelected(null); }} onRights={() => { setUpdatingRights(currentSelected); setSelected(null); }} onObserve={() => { setObserving(currentSelected); setSelected(null); }} />}
    {canUseContent && editing && currentEditing && <ContentAssetDialog key={`${session.actor.memberId}:${session.actor.role}:edit:${editing.id}`} mode="edit" asset={currentEditing} creators={availableCreators} open onOpenChange={(open) => { if (!open) setEditing(null); }} />}
    {canUseContent && updatingRights && currentRightsAsset && <ContentRightsDialog key={`${session.actor.memberId}:${session.actor.role}:rights:${updatingRights.id}`} asset={currentRightsAsset} open onOpenChange={(open) => { if (!open) setUpdatingRights(null); }} />}
    {canUseContent && observing && currentObservationAsset && <ContentObservationDialog key={`${session.actor.memberId}:${session.actor.role}:observation:${observing.id}`} asset={currentObservationAsset} open onOpenChange={(open) => { if (!open) setObserving(null); }} />}
  </div>;
}

function ContentAssetDialog({ mode, asset, delivery, deliveries = [], creators, open, onOpenChange }: { mode: 'manual' | 'delivery' | 'edit'; asset?: ContentAssetWorkspaceItem; delivery?: Delivery; deliveries?: Delivery[]; creators: ReturnType<typeof useWorkbench>['workspace']['creators']; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { workspace, run, running } = useWorkbench();
  const [error, setError] = useState('');
  const [selectedDeliveryId, setSelectedDeliveryId] = useState(delivery?.id ?? deliveries[0]?.id ?? '');
  const selectedDelivery = deliveries.find((item) => item.id === selectedDeliveryId) ?? delivery;
  const [sourceUrl, setSourceUrl] = useState('');
  const [assetTitle, setAssetTitle] = useState(asset?.title ?? selectedDelivery?.title ?? '');
  const [assetType, setAssetType] = useState<ContentAssetType>(asset?.type ?? deliveryTypeAsAssetType(selectedDelivery?.type));
  const [manualCreatorId, setManualCreatorId] = useState('');
  const creatorId = selectedDelivery?.creatorId ?? asset?.creatorId ?? manualCreatorId;
  const creatorTeamId = workspace.creators.find((item) => item.id === creatorId)?.teamId;
  const assetTeamId = asset?.teamId ?? selectedDelivery?.teamId ?? creatorTeamId;
  const products = workspace.products.filter((product) => product.teamId === assetTeamId && (product.active || Boolean(asset?.productIds.includes(product.id))));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); const form = new FormData(event.currentTarget);
    const productIds = form.getAll('productIds').map(String);
    const tags = splitTags(String(form.get('tags') ?? ''));
    try {
      if (mode === 'delivery' && selectedDelivery) {
        const approvedSourceUrl = approvedDeliverySourceUrl(selectedDelivery);
        if (!approvedSourceUrl) { setError('该交付最终验收提交没有链接，请先补充交付链接或按手工来源登记。'); return; }
        await run({ type: 'contentAsset.registerFromDelivery', deliveryId: selectedDelivery.id, expectedDeliveryVersion: selectedDelivery.version, sourceUrl: approvedSourceUrl, assetType: String(form.get('type') ?? 'short_video') as ContentAssetType, title: String(form.get('title') ?? ''), tags, productIds });
        toast.success('已验收交付已登记为内容资产');
      } else if (mode === 'edit' && asset) {
        await run({ type: 'contentAsset.update', assetId: asset.id, expectedVersion: asset.version, assetType: String(form.get('type') ?? 'other') as ContentAssetType, title: String(form.get('title') ?? ''), tags, productIds });
        toast.success('内容资料已更新');
      } else {
        const selectedCreatorId = String(form.get('creatorId') ?? '');
        const creator = creators.find((item) => item.id === selectedCreatorId);
        if (!creator) { setError('请选择达人。'); return; }
        await run({ type: 'contentAsset.create', creatorId: creator.id, sourceUrl: String(form.get('sourceUrl') ?? ''), assetType: String(form.get('type') ?? 'other') as ContentAssetType, title: String(form.get('title') ?? ''), tags, productIds });
        toast.success('内容资产已创建');
      }
      onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败，请重试。'); }
  }
  const title = mode === 'edit' ? '编辑内容资料' : mode === 'delivery' ? '登记已验收交付' : '手工登记内容';
  const creator = workspace.creators.find((item) => item.id === creatorId);
  const modalDescription = mode === 'delivery' ? '内容链接来自已验收交付。' : mode === 'edit' ? '内容链接保存后无法更改；如需更换，请重新登记。' : '登记后仍需确认授权，才能发布、改编或投放。';
  return <Modal open={open} onOpenChange={onOpenChange} title={title} description={modalDescription} className="modal-standard modal-wide">
    <form className="modal-form" onSubmit={submit}>
      {mode === 'manual' && <FormField label="达人" required><select className="native-select" name="creatorId" required value={manualCreatorId} onChange={(event) => setManualCreatorId(event.target.value)}><option value="">选择达人</option>{creators.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></FormField>}
      {mode !== 'manual' && <div className="notice notice-info">关联达人：{creator?.name ?? '达人信息暂不可用'}</div>}
      {mode === 'delivery' && <FormField label="已验收交付" required><select className="native-select" name="deliveryId" required value={selectedDeliveryId} onChange={(event) => { const next = deliveries.find((item) => item.id === event.target.value); setSelectedDeliveryId(event.target.value); setAssetTitle(next?.title ?? ''); setAssetType(deliveryTypeAsAssetType(next?.type)); }}><option value="">选择一项已验收交付</option>{deliveries.map((item) => { const itemCreator = workspace.creators.find((creatorItem) => creatorItem.id === item.creatorId); return <option key={item.id} value={item.id}>{item.title} · {itemCreator?.name ?? '达人信息暂不可用'} · {formatDateTime(item.reviews.at(-1)?.reviewedAt)}</option>; })}</select></FormField>}
      <div className="form-grid">
        <FormField label="内容标题" required className="span-2"><Input name="title" required maxLength={300} value={assetTitle} onChange={(event) => setAssetTitle(event.target.value)} placeholder="填写便于检索的内容标题" /></FormField>
        {mode === 'edit' && asset ? <div className="detail-cell span-2"><span>内容链接（保存后无法更换）</span><strong><a href={asset.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={12} />打开内容链接</a></strong></div> : <FormField label={mode === 'delivery' ? '已验收交付链接' : '内容链接'} required className="span-2" hint={mode === 'delivery' ? '如需登记其他链接，请手工登记。' : '请填写可打开的链接，不要包含账号密码。'}><Input name="sourceUrl" type="url" required maxLength={2048} value={mode === 'delivery' ? (selectedDelivery ? approvedDeliverySourceUrl(selectedDelivery) ?? '' : '') : sourceUrl} onChange={mode === 'manual' ? (event) => setSourceUrl(event.target.value) : undefined} readOnly={mode === 'delivery'} placeholder="https://" /></FormField>}
        <FormField label="内容类型" required><select className="native-select" name="type" value={assetType} onChange={(event) => setAssetType(event.target.value as ContentAssetType)}>{Object.entries(typeLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></FormField>
        <FormField label="标签"><Input name="tags" defaultValue={asset?.tags.join('，') ?? ''} placeholder="多个标签用逗号分隔" /></FormField>
        <div className="form-field span-2"><span className="field-label">关联商品</span>{products.length ? <div className="check-list">{products.map((product) => <label className="check-row" key={product.id}><input type="checkbox" name="productIds" value={product.id} defaultChecked={asset?.productIds.includes(product.id)} />{product.brand} · {product.name}{!product.active && '（已停用）'}</label>)}</div> : <span className="text-muted">{mode === 'manual' && !manualCreatorId ? '选择达人后查看其团队商品。' : '当前团队没有可关联商品。'}</span>}</div>
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="notice notice-info">保存后授权状态为“未核实”。发布、改编或投放前，请先确认已获授权。</div>
      <div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running || (mode === 'manual' && !creators.length)}>{running ? '保存中…' : mode === 'edit' ? '保存资料' : '登记内容'}</Button></div>
    </form>
  </Modal>;
}

function ContentDetail({ asset, observations, open, onOpenChange, canUseContent, onEdit, onRights, onObserve }: { asset: ContentAssetWorkspaceItem; observations: ContentObservation[]; open: boolean; onOpenChange: (open: boolean) => void; canUseContent: boolean; onEdit: () => void; onRights: () => void; onObserve: () => void }) {
  const { workspace } = useWorkbench();
  const creator = workspace.creators.find((item) => item.id === asset.creatorId);
  const rights = rightsPresentation(asset);
  const rightsRange = `${asset.rightsValidFrom ? formatDateTime(asset.rightsValidFrom) : '未设置'} 至 ${asset.rightsValidUntil ? formatDateTime(asset.rightsValidUntil) : '未设置'}`;
  return <Modal open={open} onOpenChange={onOpenChange} title={asset.title} description={`${creator?.name ?? '达人信息暂不可用'} · ${typeLabels[asset.type]}`} className="modal-standard modal-wide">
    <div className="detail-summary-row"><StatusPill value={asset.rightsStatus} label={rights.label} tone={rights.tone} /><span>最近更新 {formatDateTime(asset.updatedAt)}</span></div>
    <section className="detail-section"><h3>内容资料</h3><div className="detail-grid"><div className="detail-cell"><span>内容链接</span><strong><a href={asset.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={12} />打开内容链接</a></strong></div><div className="detail-cell"><span>关联交付</span><strong>{asset.deliveryId ? '已验收交付' : '手工登记'}</strong></div><div className="detail-cell"><span>关联商品</span><strong>{asset.productIds.map((id) => workspace.products.find((product) => product.id === id)?.name).filter(Boolean).join('、') || '未关联商品'}</strong></div><div className="detail-cell"><span>标签</span><strong>{asset.tags.join('、') || '未设置'}</strong></div></div></section>
    <section className="detail-section"><h3>授权信息</h3><div className="detail-grid"><div className="detail-cell"><span>授权状态</span><strong>{rights.label}</strong></div><div className="detail-cell"><span>有效时间</span><strong>{rightsRange}</strong></div><div className="detail-cell"><span>可用范围</span><strong>{rights.activeScopes.map((scope) => rightScopeLabels[scope]).join('、') || '无'}</strong></div><div className="detail-cell"><span>授权依据</span><strong>{asset.rightsEvidenceUrl ? <a href={asset.rightsEvidenceUrl} target="_blank" rel="noreferrer"><ExternalLink size={12} />查看授权依据</a> : '未提供'}</strong></div></div>{asset.rightsStatus === 'authorized' && asset.rightsValidFrom && Date.parse(asset.rightsValidFrom) > Date.now() && <p className="detail-note">授权尚未开始，当前不能使用。</p>}{asset.rightsStatus === 'authorized' && asset.rightsValidUntil && Date.parse(asset.rightsValidUntil) <= Date.now() && <p className="detail-note">授权已过期，当前不能使用。</p>}</section>
    <section className="detail-section"><div className="timeline-title-row"><h3>内容表现记录</h3><span>{observations.length} 条</span></div><p className="detail-empty-note">手工填写的数据与导入订单分开统计，每次登记都会保留。</p>{observations.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>来源 / 数据时间</th><th>播放</th><th>点赞</th><th>评论</th><th>分享</th><th>订单数</th><th>支付金额</th></tr></thead><tbody>{observations.map((observation) => <tr key={observation.id}><td><span className="table-primary">{observation.source}</span><span className="table-secondary">数据时间 {formatDateTime(observation.observedAt)}</span>{observation.note && <span className="table-secondary">{observation.note}</span>}</td><td>{observation.views ?? '—'}</td><td>{observation.likes ?? '—'}</td><td>{observation.comments ?? '—'}</td><td>{observation.shares ?? '—'}</td><td>{observation.orders ?? '—'}</td><td>{formatMoney(observation.observedPaidCents)}</td></tr>)}</tbody></table></div> : <p className="text-muted detail-empty-note">暂无表现记录。未填写的数据表示未知。</p>}</section>
    <div className="detail-actions">{canUseContent && <><Button variant="outline" onClick={onEdit}>编辑资料</Button><Button variant="outline" onClick={onRights}>更新授权状态</Button><Button onClick={onObserve}>记录内容表现</Button></>}{!canUseContent && <span className="text-muted">当前无法编辑内容资产。</span>}</div>
  </Modal>;
}

function ContentRightsDialog({ asset, open, onOpenChange }: { asset: ContentAssetWorkspaceItem; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { run, running } = useWorkbench();
  const [error, setError] = useState('');
  const [rightsStatus, setRightsStatus] = useState<ContentRightsStatus>(asset.rightsStatus);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); const form = new FormData(event.currentTarget);
    const selectedScopes = form.getAll('rightsScope').map(String) as ContentRightScope[];
    const rightsValidFromRaw = String(form.get('rightsValidFrom') ?? '');
    const rightsValidUntilRaw = String(form.get('rightsValidUntil') ?? '');
    const evidenceUrl = String(form.get('rightsEvidenceUrl') ?? '').trim();
    if (rightsStatus === 'authorized' && !selectedScopes.length) { setError('授权状态至少选择一项授权范围。'); return; }
    if (rightsStatus === 'authorized' && !rightsValidFromRaw) { setError('授权状态必须填写开始时间。'); return; }
    if (rightsStatus === 'authorized' && !evidenceUrl) { setError('授权状态必须附上可核验的依据链接。'); return; }
    if (rightsValidFromRaw && rightsValidUntilRaw && Date.parse(shanghaiInputToIso(rightsValidFromRaw)) >= Date.parse(shanghaiInputToIso(rightsValidUntilRaw))) { setError('授权截止时间必须晚于开始时间。'); return; }
    try {
      await run({ type: 'contentAsset.updateRights', assetId: asset.id, expectedVersion: asset.version, rightsStatus, rightsScope: selectedScopes, rightsValidFrom: rightsValidFromRaw ? shanghaiInputToIso(rightsValidFromRaw) : null, rightsValidUntil: rightsValidUntilRaw ? shanghaiInputToIso(rightsValidUntilRaw) : null, rightsEvidenceUrl: evidenceUrl || null, reason: String(form.get('reason') ?? '') || null });
      toast.success('授权记录已更新'); onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '更新授权失败。'); }
  }
  return <Modal open={open} onOpenChange={onOpenChange} title="更新授权状态" description={asset.title}>
    <form className="modal-form" onSubmit={submit}>
      <FormField label="授权状态" required><select className="native-select" name="rightsStatus" value={rightsStatus} onChange={(event) => setRightsStatus(event.target.value as ContentRightsStatus)}><option value="unknown">未核实</option><option value="pending">待授权</option><option value="authorized">已授权</option><option value="revoked">已撤回</option></select></FormField>
      <div className="form-field"><span className="field-label">授权范围{rightsStatus === 'authorized' && <b aria-hidden="true"> *</b>}</span><div className="check-list">{Object.entries(rightScopeLabels).map(([key, label]) => <label className="check-row" key={key}><input type="checkbox" name="rightsScope" value={key} defaultChecked={asset.rightsScope.includes(key as ContentRightScope)} disabled={rightsStatus !== 'authorized'} />{label}</label>)}</div>{rightsStatus !== 'authorized' && <small>选择“已授权”后可填写授权范围。</small>}</div>
      <div className="form-grid"><FormField label="授权开始时间" required={rightsStatus === 'authorized'}><Input name="rightsValidFrom" type="datetime-local" required={rightsStatus === 'authorized'} defaultValue={asset.rightsValidFrom ? isoToLocalDateTime(asset.rightsValidFrom) : ''} /></FormField><FormField label="授权截止时间"><Input name="rightsValidUntil" type="datetime-local" defaultValue={asset.rightsValidUntil ? isoToLocalDateTime(asset.rightsValidUntil) : ''} /></FormField></div>
      <FormField label="授权依据链接" required={rightsStatus === 'authorized'} hint={rightsStatus === 'authorized' ? '请附合同、平台授权或书面确认链接。' : '有合同、平台授权或书面确认时可附上。'}><Input name="rightsEvidenceUrl" type="url" required={rightsStatus === 'authorized'} defaultValue={asset.rightsEvidenceUrl ?? ''} placeholder="https://" maxLength={2048} /></FormField>
      <FormField label="变更说明"><Textarea name="reason" rows={2} placeholder="填写授权核验或状态变更原因" /></FormField>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running}>{running ? '保存中…' : '保存授权记录'}</Button></div>
    </form>
  </Modal>;
}

function ContentObservationDialog({ asset, open, onOpenChange }: { asset: ContentAssetWorkspaceItem; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { run, running } = useWorkbench();
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); const form = new FormData(event.currentTarget);
    const fields = ['views', 'likes', 'comments', 'shares', 'orders'] as const;
    const numericValues = Object.fromEntries(fields.map((field) => { const value = String(form.get(field) ?? '').trim(); return [field, value ? parseNonnegativeInteger(value) : null]; }));
    const invalidField = fields.find((field) => String(form.get(field) ?? '').trim() && numericValues[field] === null);
    const amountValue = String(form.get('observedPaid') ?? '').trim();
    const amountCents = amountValue ? parseNonnegativeCents(amountValue) : null;
    if (invalidField) { setError('播放、互动和订单数须填非负整数；未知项请留空。'); return; }
    if (amountValue && amountCents === null) { setError('支付金额格式不正确，请填写有效金额。'); return; }
    try {
      await run({ type: 'contentObservation.append', assetId: asset.id, expectedAssetVersion: asset.version, source: String(form.get('source') ?? ''), observedAt: shanghaiInputToIso(String(form.get('observedAt') ?? '')), views: numericValues.views, likes: numericValues.likes, comments: numericValues.comments, shares: numericValues.shares, orders: numericValues.orders, observedPaidCents: amountCents, note: String(form.get('note') ?? '') || null });
      toast.success('内容表现记录已添加'); onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '添加记录失败，请重试。'); }
  }
  return <Modal open={open} onOpenChange={onOpenChange} title="记录内容表现" description={asset.title} className="modal-standard modal-wide">
    <form className="modal-form" onSubmit={submit}>
      <div className="notice notice-info">手工填写的数据与导入订单分开统计，每次登记都会保留。未确认的指标请留空。</div>
      <div className="form-grid"><FormField label="来源" required><Input name="source" required maxLength={300} placeholder="例如：平台数据页、达人反馈" /></FormField><FormField label="数据时间" required><Input name="observedAt" type="datetime-local" required defaultValue={shanghaiDateTimeInput()} /></FormField><FormField label="播放量"><Input name="views" type="number" min={0} step={1} inputMode="numeric" /></FormField><FormField label="点赞数"><Input name="likes" type="number" min={0} step={1} inputMode="numeric" /></FormField><FormField label="评论数"><Input name="comments" type="number" min={0} step={1} inputMode="numeric" /></FormField><FormField label="分享数"><Input name="shares" type="number" min={0} step={1} inputMode="numeric" /></FormField><FormField label="订单数"><Input name="orders" type="number" min={0} step={1} inputMode="numeric" /></FormField><FormField label="支付金额（元）"><Input name="observedPaid" type="number" min={0} step="0.01" inputMode="decimal" /></FormField><FormField label="备注" className="span-2"><Textarea name="note" rows={2} /></FormField></div>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running}>{running ? '保存中…' : '保存记录'}</Button></div>
    </form>
  </Modal>;
}

function isoToLocalDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

function deliveryTypeAsAssetType(type: Delivery['type'] | undefined): ContentAssetType {
  if (type === 'live') return 'live';
  if (type === 'short_video') return 'short_video';
  return 'other';
}

function approvedDeliverySourceUrl(delivery: Delivery): string | null {
  const review = delivery.reviews.at(-1);
  if (review?.decision !== 'approved') return null;
  const submission = delivery.submissions[review.submissionIndex];
  return submission?.contentUrl ?? submission?.evidenceUrl ?? null;
}
