import { useMemo, useState, type FormEvent } from 'react';
import '../operations-surfaces.css';
import { toast } from 'sonner';
import { Building2, Handshake, Plus, Search, Users } from 'lucide-react';
import type { CooperationPartnerLink, PartnerResource, PartnerResourceKind } from '@shared/types';
import { useWorkbench } from '../workbench-context';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { EmptyState, FormField, formatDateTime, Modal, PageHeading, Panel, StatusPill } from '../components/workbench';
import { canManageBusiness, splitTags } from '../lib/business-ui';

const kindLabels: Record<PartnerResourceKind, string> = { leader: '团长', agency: '机构' };
const linkRoleLabels: Record<CooperationPartnerLink['role'], string> = { lead_source: '资源引荐', service_provider: '服务支持', other: '其他关联' };

export default function PartnersPage() {
  const { session, workspace } = useWorkbench();
  const canManage = canManageBusiness(session.actor.role);
  const canView = canManage || session.actor.role === 'bd';
  const partnerResources = canView ? workspace.partnerResources : [];
  const partnerLinks = canView ? workspace.cooperationPartnerLinks : [];
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | PartnerResourceKind>('all');
  const [statusFilter, setStatusFilter] = useState<'active' | 'inactive' | 'all'>('active');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<PartnerResource | null>(null);
  const [editingLink, setEditingLink] = useState<CooperationPartnerLink | null>(null);
  const [selected, setSelected] = useState<PartnerResource | null>(null);
  const [linkingResource, setLinkingResource] = useState<PartnerResource | null>(null);
  const activeResources = partnerResources.filter((resource) => resource.active);
  const selectedResource = selected ? partnerResources.find((item) => item.id === selected.id) : undefined;
  const currentEditingResource = editing ? workspace.partnerResources.find((item) => item.id === editing.id) : undefined;
  const currentLinkingResource = linkingResource ? partnerResources.find((item) => item.id === linkingResource.id) : undefined;
  const currentEditingLink = editingLink ? partnerLinks.find((link) => link.id === editingLink.id) : undefined;
  const editingLinkCooperation = currentEditingLink ? workspace.cooperations.find((item) => item.id === currentEditingLink.cooperationId) : undefined;
  const editingLinkCreator = editingLinkCooperation ? workspace.creators.find((item) => item.id === editingLinkCooperation.creatorId) : undefined;
  const canEditCurrentLink = canManage || (session.actor.role === 'bd' && editingLinkCooperation?.status === 'draft' && editingLinkCooperation.ownerMemberId === session.actor.memberId && editingLinkCreator?.ownerMemberId === session.actor.memberId);
  const visibleResources = partnerResources.filter((resource) => {
    const matchesKind = kindFilter === 'all' || resource.kind === kindFilter;
    const matchesStatus = statusFilter === 'all' || (statusFilter === 'active' ? resource.active : !resource.active);
    const searchable = `${resource.name} ${resource.summary} ${resource.tags.join(' ')}`.toLocaleLowerCase();
    return matchesKind && matchesStatus && searchable.includes(query.trim().toLocaleLowerCase());
  });
  const activeLinkCount = partnerLinks.filter((link) => link.active).length;

  return <div className="page-stack ops-page ops-page--partners">
    <PageHeading title="团长与机构" description="管理合作资源，并关联到合作单。" actions={canManage && <Button onClick={() => setCreateOpen(true)}><Plus size={15} />新增资源</Button>} />
    {canView && <div className="page-grid metrics-grid">
      <div className="small-metric"><span>资源总数</span><strong>{partnerResources.length}</strong><small>含已停用档案</small></div>
      <div className="small-metric"><span>当前可用</span><strong>{activeResources.length}</strong></div>
      <div className="small-metric"><span>团长</span><strong>{activeResources.filter((resource) => resource.kind === 'leader').length}</strong></div>
      <div className="small-metric"><span>合作关联</span><strong>{activeLinkCount}</strong><small>有效关联</small></div>
    </div>}
    <Panel title="合作资源">
      <div className="toolbar">
        <label className="search-field"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、摘要或标签" aria-label="搜索团长与机构" /></label>
        <label className="date-filter-label">资源类型<select className="native-select" value={kindFilter} onChange={(event) => setKindFilter(event.target.value as typeof kindFilter)} aria-label="按资源类型筛选"><option value="all">全部类型</option><option value="leader">团长</option><option value="agency">机构</option></select></label>
        <label className="date-filter-label">资源状态<select className="native-select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)} aria-label="按资源状态筛选"><option value="active">当前可用</option><option value="inactive">已停用</option><option value="all">全部状态</option></select></label>
        <span className="toolbar-spacer" /><span className="table-result-count">{visibleResources.length} 条资源</span>
      </div>
      {visibleResources.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>资源</th><th>合作摘要</th><th>标签</th><th>可用状态</th><th>最近更新</th><th className="text-right">操作</th></tr></thead><tbody>{visibleResources.map((resource) => {
        const resourceLinks = partnerLinks.filter((link) => link.partnerResourceId === resource.id && link.active);
        const canLink = canManage || canLinkToOwnDraft(session.actor.memberId, resource, workspace.creators, workspace.cooperations);
        return <tr key={resource.id}>
          <td><button type="button" className="link-button table-primary" onClick={() => setSelected(resource)}>{resource.name}</button><span className="table-secondary">{kindLabels[resource.kind]} · {resourceLinks.length} 条合作关联</span></td>
          <td className="partner-summary-cell">{resource.summary}</td>
          <td><div className="tag-list">{resource.tags.length ? resource.tags.map((tag) => <span className="tag-chip" key={tag}>{tag}</span>) : <span className="text-muted">暂无标签</span>}</div></td>
          <td><StatusPill value={resource.active ? 'active' : 'inactive'} label={resource.active ? '可用' : '已停用'} tone={resource.active ? 'green' : 'neutral'} /></td>
          <td>{formatDateTime(resource.updatedAt)}</td>
          <td className="table-action-cell"><div className="inline-actions"><Button variant="outline" size="sm" className="small-button" onClick={() => setSelected(resource)}>查看</Button>{canManage && <Button variant="outline" size="sm" className="small-button" onClick={() => setEditing(resource)}>编辑</Button>}{resource.active && canLink && <Button variant="outline" size="sm" className="small-button" onClick={() => setLinkingResource(resource)}><Handshake size={12} />关联合作</Button>}</div></td>
        </tr>;
      })}</tbody></table></div> : <EmptyState title={!canView ? '暂无法查看合作资源' : query ? '没有匹配资源' : '还没有合作资源'} description={!canView ? '请联系管理员开通查看权限。' : query ? '试试更短的名称或标签。' : canManage ? '新增团长或机构资料后，可关联到合作单。' : '本团队暂无合作资源。'} icon={<Users size={21} />} action={canManage && <Button size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} />新增资源</Button>} />}
    </Panel>
    <Panel title="合作关联记录">
      <PartnerLinksTable links={partnerLinks} resources={partnerResources} canManage={canManage} memberId={session.actor.memberId} onEdit={setEditingLink} />
    </Panel>
    {canManage && createOpen && <PartnerResourceDialog key={`${session.actor.memberId}:${session.actor.role}`} open onOpenChange={setCreateOpen} />}
    {canManage && currentEditingResource && editing && <PartnerResourceDialog key={`${session.actor.memberId}:${session.actor.role}:${editing.id}`} resource={currentEditingResource} open onOpenChange={(open) => { if (!open) setEditing(null); }} />}
    {canView && selectedResource && selected && <PartnerDetail resource={selectedResource} open onOpenChange={(open) => { if (!open) setSelected(null); }} onEdit={() => { setEditing(selectedResource); setSelected(null); }} onLink={() => setLinkingResource(selectedResource)} canManage={canManage} canLink={selectedResource.active && (canManage || canLinkToOwnDraft(session.actor.memberId, selectedResource, workspace.creators, workspace.cooperations))} />}
    {canView && currentLinkingResource && linkingResource && <PartnerLinkDialog key={`${session.actor.memberId}:${session.actor.role}:${linkingResource.id}`} resource={currentLinkingResource} open onOpenChange={(open) => { if (!open) setLinkingResource(null); }} />}
    {currentEditingLink && canEditCurrentLink && <PartnerLinkEditDialog key={`${session.actor.memberId}:${session.actor.role}:${editingLink?.id ?? ''}`} link={currentEditingLink} open onOpenChange={(open) => { if (!open) setEditingLink(null); }} />}
  </div>;
}

function canLinkToOwnDraft(memberId: string, resource: PartnerResource, creators: ReturnType<typeof useWorkbench>['workspace']['creators'], cooperations: ReturnType<typeof useWorkbench>['workspace']['cooperations']) {
  const ownedCreatorIds = new Set(creators.filter((creator) => creator.ownerMemberId === memberId).map((creator) => creator.id));
  return cooperations.some((cooperation) => cooperation.teamId === resource.teamId && cooperation.status === 'draft' && cooperation.ownerMemberId === memberId && ownedCreatorIds.has(cooperation.creatorId));
}

function PartnerResourceDialog({ resource, open, onOpenChange }: { resource?: PartnerResource; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { session, workspace, run, running } = useWorkbench();
  const [error, setError] = useState('');
  const teams = workspace.teams.filter((team) => session.actor.role === 'admin' || team.id === session.actor.teamId);
  const defaultTeamId = teams.find((team) => team.id === session.actor.teamId)?.id ?? teams[0]?.id ?? session.actor.teamId;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); const form = new FormData(event.currentTarget);
    const tags = splitTags(String(form.get('tags') ?? ''));
    try {
      if (resource) {
        await run({ type: 'partnerResource.update', resourceId: resource.id, expectedVersion: resource.version, name: String(form.get('name') ?? ''), summary: String(form.get('summary') ?? ''), tags, contactName: String(form.get('contactName') ?? '') || null, contactPhone: String(form.get('contactPhone') ?? '') || null, contactHandle: String(form.get('contactHandle') ?? '') || null, privateNote: String(form.get('privateNote') ?? '') || null, active: form.get('active') === 'on' });
        toast.success('资源档案已更新');
      } else {
        const teamId = String(form.get('teamId') ?? defaultTeamId);
        await run({ type: 'partnerResource.create', teamId, kind: String(form.get('kind') ?? 'leader') as PartnerResourceKind, name: String(form.get('name') ?? ''), summary: String(form.get('summary') ?? ''), tags, contactName: String(form.get('contactName') ?? '') || null, contactPhone: String(form.get('contactPhone') ?? '') || null, contactHandle: String(form.get('contactHandle') ?? '') || null, privateNote: String(form.get('privateNote') ?? '') || null });
        toast.success('合作资源已创建');
      }
      onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败，请重试。'); }
  }
  return <Modal open={open} onOpenChange={onOpenChange} title={resource ? '编辑合作资源' : '新增合作资源'}>
    <form className="modal-form" onSubmit={submit}>
      <div className="form-grid">
        {!resource && <FormField label="资源类型" required><select className="native-select" name="kind" defaultValue="leader"><option value="leader">团长</option><option value="agency">机构</option></select></FormField>}
        {!resource && (session.actor.role === 'admin' || teams.length > 1) && <FormField label="所属团队" required><select className="native-select" name="teamId" defaultValue={defaultTeamId}>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></FormField>}
        <FormField label="资源名称" required className="span-2"><Input name="name" required defaultValue={resource?.name ?? ''} maxLength={300} placeholder="填写团长或机构名称" /></FormField>
        <FormField label="合作摘要" required className="span-2"><Textarea name="summary" required rows={3} defaultValue={resource?.summary ?? ''} placeholder="介绍资源和合作方式，请勿填写个人联系方式" /></FormField>
        <FormField label="标签" className="span-2"><Input name="tags" defaultValue={resource?.tags.join('，') ?? ''} placeholder="多个标签用中文逗号或换行分隔" /></FormField>
        <FormField label="联系人姓名" hint="联系人和内部备注仅管理员、主管可见。"><Input name="contactName" defaultValue={resource?.contactName ?? ''} maxLength={200} /></FormField>
        <FormField label="电话"><Input name="contactPhone" type="tel" inputMode="tel" defaultValue={resource?.contactPhone ?? ''} maxLength={80} /></FormField>
        <FormField label="微信号 / 其他联系账号"><Input name="contactHandle" defaultValue={resource?.contactHandle ?? ''} maxLength={300} /></FormField>
        <FormField label="内部备注" className="span-2"><Textarea name="privateNote" rows={2} defaultValue={resource?.privateNote ?? ''} /></FormField>
      </div>
      {resource && <label className="check-row"><input type="checkbox" name="active" defaultChecked={resource.active} />当前可用于新增合作关联</label>}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running}>{running ? '保存中…' : resource ? '保存档案' : '创建资源'}</Button></div>
    </form>
  </Modal>;
}

function PartnerDetail({ resource, open, onOpenChange, onEdit, onLink, canManage, canLink }: { resource: PartnerResource; open: boolean; onOpenChange: (open: boolean) => void; onEdit: () => void; onLink: () => void; canManage: boolean; canLink: boolean }) {
  const { workspace } = useWorkbench();
  const links = workspace.cooperationPartnerLinks.filter((link) => link.partnerResourceId === resource.id);
  const visibleCooperations = useMemo(() => new Map(workspace.cooperations.map((item) => [item.id, item])), [workspace.cooperations]);
  return <Modal open={open} onOpenChange={onOpenChange} title={resource.name} description={`${kindLabels[resource.kind]} · 最近更新 ${formatDateTime(resource.updatedAt)}`} className="modal-standard modal-wide">
    <div className="detail-summary-row"><StatusPill value={resource.active ? 'active' : 'inactive'} label={resource.active ? '可用资源' : '已停用'} tone={resource.active ? 'green' : 'neutral'} /></div>
    <section className="detail-section"><h3>合作摘要</h3><p className="detail-note">{resource.summary}</p><div className="detail-tags">{resource.tags.length ? resource.tags.map((tag) => <span className="tag-chip" key={tag}>{tag}</span>) : <span className="text-muted">暂无标签</span>}</div></section>
    {canManage && <section className="detail-section"><h3>联系人信息</h3><div className="detail-grid"><div className="detail-cell"><span>联系人</span><strong>{resource.contactName ?? '未记录'}</strong></div><div className="detail-cell"><span>电话</span><strong>{resource.contactPhone ?? '未记录'}</strong></div><div className="detail-cell"><span>微信号 / 联系账号</span><strong>{resource.contactHandle ?? '未记录'}</strong></div></div>{resource.privateNote && <p className="detail-note">{resource.privateNote}</p>}</section>}
    <section className="detail-section"><div className="timeline-title-row"><h3>合作关联</h3><span>{links.length} 条</span></div>{links.length ? <div className="detail-products">{links.map((link) => { const cooperation = visibleCooperations.get(link.cooperationId); return <div className="detail-product-row" key={link.id}><div><strong>{cooperation?.title ?? '合作信息暂不可用'}</strong></div><span>{linkRoleLabels[link.role]}</span><StatusPill value={link.active ? 'active' : 'inactive'} label={link.active ? '有效' : '已停用'} tone={link.active ? 'green' : 'neutral'} />{link.note && <small>{link.note}</small>}</div>; })}</div> : <p className="text-muted detail-empty-note">暂无合作关联。</p>}</section>
    <div className="detail-actions">{canManage && <Button variant="outline" onClick={onEdit}>编辑资源</Button>}{canLink && <Button variant="outline" onClick={onLink}><Handshake size={14} />关联合作</Button>}</div>
  </Modal>;
}

function PartnerLinkDialog({ resource, open, onOpenChange }: { resource: PartnerResource; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { session, workspace, run, running } = useWorkbench();
  const [error, setError] = useState('');
  const canManage = canManageBusiness(session.actor.role);
  const ownedCreators = new Set(workspace.creators.filter((creator) => creator.ownerMemberId === session.actor.memberId).map((creator) => creator.id));
  const options = workspace.cooperations.filter((cooperation) => cooperation.teamId === resource.teamId && cooperation.status === 'draft' && (canManage || (cooperation.ownerMemberId === session.actor.memberId && ownedCreators.has(cooperation.creatorId))));
  const linkedCooperationIds = new Set(workspace.cooperationPartnerLinks.filter((link) => link.partnerResourceId === resource.id).map((link) => link.cooperationId));
  const availableOptions = options.filter((cooperation) => !linkedCooperationIds.has(cooperation.id));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); const form = new FormData(event.currentTarget);
    try {
      await run({ type: 'cooperationPartnerLink.create', cooperationId: String(form.get('cooperationId') ?? ''), partnerResourceId: resource.id, role: String(form.get('role') ?? 'lead_source') as CooperationPartnerLink['role'], note: String(form.get('note') ?? '') || null });
      toast.success('合作关联已记录'); onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '关联失败，请重试。'); }
  }
  return <Modal open={open} onOpenChange={onOpenChange} title="关联到合作单" description={resource.name}>
    <form className="modal-form" onSubmit={submit}>
      <FormField label="草稿合作" required><select className="native-select" name="cooperationId" required defaultValue=""><option value="">选择合作单</option>{availableOptions.map((cooperation) => { const creator = workspace.creators.find((item) => item.id === cooperation.creatorId); return <option key={cooperation.id} value={cooperation.id}>{cooperation.title} · {creator?.name ?? '达人信息暂不可用'}</option>; })}</select></FormField>
      <FormField label="关联角色" required><select className="native-select" name="role" defaultValue="lead_source"><option value="lead_source">资源引荐</option><option value="service_provider">服务支持</option><option value="other">其他关联</option></select></FormField>
      <FormField label="关联备注"><Textarea name="note" rows={2} placeholder="说明资源与本次合作的关系" /></FormField>
      {error && <p className="field-error" role="alert">{error}</p>}
      {!availableOptions.length && <p className="field-error" role="status">{options.length ? '现有草稿合作均已关联，可在资源档案查看。' : canManage ? '没有可关联的草稿合作，请先创建合作草稿。' : '没有可关联的合作草稿，请先创建本人负责的草稿合作。'}</p>}
      <div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>关闭</Button><Button type="submit" disabled={running || availableOptions.length === 0}>{running ? '保存中…' : '保存关联'}</Button></div>
    </form>
  </Modal>;
}

function PartnerLinksTable({ links, resources, canManage, memberId, onEdit }: { links: CooperationPartnerLink[]; resources: PartnerResource[]; canManage: boolean; memberId: string; onEdit: (link: CooperationPartnerLink) => void }) {
  const { workspace, run, running } = useWorkbench();
  const cooperationMap = new Map(workspace.cooperations.map((item) => [item.id, item]));
  const creatorMap = new Map(workspace.creators.map((item) => [item.id, item]));
  async function setActive(link: CooperationPartnerLink, active: boolean) {
    try { await run({ type: 'cooperationPartnerLink.update', linkId: link.id, expectedVersion: link.version, active }); toast.success(active ? '关联已恢复' : '关联已停用'); }
    catch (cause) { toast.error(cause instanceof Error ? cause.message : '更新关联失败'); }
  }
  const rows = links.filter((link) => cooperationMap.has(link.cooperationId));
  return rows.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>合作单 / 达人</th><th>资源</th><th>关联角色</th><th>关联状态</th><th className="text-right">操作</th></tr></thead><tbody>{rows.map((link) => {
    const cooperation = cooperationMap.get(link.cooperationId);
    const creator = cooperation ? creatorMap.get(cooperation.creatorId) : undefined;
    const resource = resources.find((item) => item.id === link.partnerResourceId);
    const mayEdit = canManage || (cooperation?.status === 'draft' && cooperation.ownerMemberId === memberId && creator?.ownerMemberId === memberId);
    if (!resource) return null;
    return <tr key={link.id}><td><span className="table-primary">{cooperation?.title ?? '合作信息暂不可用'}</span><span className="table-secondary">{creator?.name ?? '达人信息暂不可用'}</span></td><td><span className="table-primary">{resource.name}</span><span className="table-secondary">{kindLabels[resource.kind]}</span></td><td>{linkRoleLabels[link.role]}{link.note && <span className="table-secondary">{link.note}</span>}</td><td><StatusPill value={link.active ? 'active' : 'inactive'} label={link.active ? '有效' : '已停用'} tone={link.active ? 'green' : 'neutral'} /></td><td className="table-action-cell">{mayEdit && <div className="inline-actions"><Button variant="outline" size="sm" className="small-button" onClick={() => onEdit(link)}>编辑</Button><Button variant="ghost" size="sm" className="small-button" disabled={running} onClick={() => void setActive(link, !link.active)}>{link.active ? '停用关联' : '恢复关联'}</Button></div>}</td></tr>;
  })}</tbody></table></div> : <EmptyState title="还没有合作关联" description="在资源档案中选择“关联合作”，把团长或机构与一笔草稿合作联系起来。" icon={<Building2 size={21} />} />;
}

function PartnerLinkEditDialog({ link, open, onOpenChange }: { link: CooperationPartnerLink; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { run, running } = useWorkbench();
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); const form = new FormData(event.currentTarget);
    try {
      await run({ type: 'cooperationPartnerLink.update', linkId: link.id, expectedVersion: link.version, role: String(form.get('role') ?? link.role) as CooperationPartnerLink['role'], note: String(form.get('note') ?? '') || null, active: form.get('active') === 'on' });
      toast.success('合作关联已更新'); onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存关联失败。'); }
  }
  return <Modal open={open} onOpenChange={onOpenChange} title="编辑合作关联" description="更新关联角色、备注或状态。"><form className="modal-form" onSubmit={submit}><FormField label="关联角色" required><select className="native-select" name="role" defaultValue={link.role}><option value="lead_source">资源引荐</option><option value="service_provider">服务支持</option><option value="other">其他关联</option></select></FormField><FormField label="关联备注"><Textarea name="note" rows={2} defaultValue={link.note ?? ''} placeholder="说明资源与本次合作的关系" /></FormField><label className="check-row"><input type="checkbox" name="active" defaultChecked={link.active} />保持关联有效</label>{error && <p className="field-error" role="alert">{error}</p>}<div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running}>{running ? '保存中…' : '保存关联'}</Button></div></form></Modal>;
}
