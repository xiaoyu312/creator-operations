import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Building2, Check, Pencil, Plus, RefreshCw, ShieldCheck, UserRound, X } from 'lucide-react';
import type { SessionResponse } from '@shared/http';
import type { WorkbookBrand, WorkbookBrandMember, WorkbookBrandMemberInput } from '@shared/brands';
import { isUnavailableDemoBrand } from '@shared/scenario-brand';
import { ApiError, createWorkbookBrand, listWorkbookBrandMembers, listWorkbookBrands, updateWorkbookBrand, upsertWorkbookBrandMember } from '../api';
import { UserSelect } from '@/components/business-ui/user-select';
import MemberInvitationsPanel from '../components/MemberInvitationsPanel';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { EmptyState, FormField, PageHeading, Panel } from '../components/workbench';
import { brandNavigationUrl, getWorkbookContext } from '../lib/workbook-context';
import '../brand-management.css';

type MemberDraft = {
  principalId: string | null;
  displayName: string;
  businessOwnerName: string;
  active: boolean;
  expectedVersion: number;
};

function openBrand(brandId: string) {
  window.location.assign(brandNavigationUrl(window.location.href, brandId));
}

export default function BrandsPage({ session }: { session: SessionResponse }) {
  const queryClient = useQueryClient();
  const workbook = getWorkbookContext(session);
  const currentBrandId = session.businessWorkspace?.brandId ?? workbook?.brandId ?? null;
  const [newName, setNewName] = useState('');
  const [editingBrandId, setEditingBrandId] = useState('');
  const [editingName, setEditingName] = useState('');
  const [error, setError] = useState('');
  const [memberDraft, setMemberDraft] = useState<MemberDraft | null>(null);
  const [memberMessage, setMemberMessage] = useState('');
  const [memberConflict, setMemberConflict] = useState(false);
  const isManager = session.canManageBrands === true;
  const brandsQuery = useQuery({
    queryKey: ['workbook-brands'],
    queryFn: listWorkbookBrands,
    enabled: isManager,
    staleTime: 15_000,
  });
  const membersQuery = useQuery({
    queryKey: ['workbook-brand-members', currentBrandId],
    queryFn: () => currentBrandId ? listWorkbookBrandMembers(currentBrandId) : Promise.resolve({ members: [] }),
    enabled: isManager && Boolean(currentBrandId),
    staleTime: 15_000,
  });

  const createMutation = useMutation({
    mutationFn: createWorkbookBrand,
    onSuccess: async (brand) => {
      await queryClient.invalidateQueries({ queryKey: ['workbook-brands'] });
      setNewName('');
      setError('');
      openBrand(brand.id);
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : '品牌创建失败。'),
  });
  const updateMutation = useMutation({
    mutationFn: ({ brandId, name, active, expectedVersion }: { brandId: string; name?: string; active?: boolean; expectedVersion: number }) =>
      updateWorkbookBrand(brandId, { ...(name !== undefined ? { name } : {}), ...(active !== undefined ? { active } : {}), expectedVersion }),
    onSuccess: async (updated) => {
      setError('');
      setEditingBrandId('');
      setEditingName('');
      await queryClient.invalidateQueries({ queryKey: ['workbook-brands'] });
      if (updated.id === currentBrandId && updated.active === false) {
        const next = (brandsQuery.data?.brands ?? []).find((brand) => brand.id !== updated.id && brand.active && !isUnavailableDemoBrand(brand));
        if (next) openBrand(next.id);
        else {
          const url = new URL(window.location.href);
          url.searchParams.delete('brandId');
          window.location.assign(`${url.pathname}${url.search}`);
        }
      } else window.location.reload();
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : '品牌更新失败。'),
  });
  const memberMutation = useMutation({
    mutationFn: ({ brandId, input }: { brandId: string; input: WorkbookBrandMemberInput }) => upsertWorkbookBrandMember(brandId, input),
    onSuccess: async (_member, variables) => {
      setMemberConflict(false);
      setMemberDraft(null);
      setMemberMessage(variables.input.expectedVersion === 0 ? '成员已添加。' : '成员信息已更新。');
      await queryClient.invalidateQueries({ queryKey: ['workbook-brand-members', variables.brandId] });
    },
    onError: (cause) => {
      if (cause instanceof ApiError && cause.code === 'VERSION_CONFLICT') {
        setMemberConflict(true);
        setMemberMessage('成员信息已更新，请刷新列表后重试。');
        return;
      }
      setMemberMessage(cause instanceof Error ? cause.message : '成员信息保存失败。');
    },
  });

  function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newName.trim();
    if (!name) { setError('请填写品牌名称。'); return; }
    setError('');
    createMutation.mutate({ name });
  }

  function submitRename(event: FormEvent<HTMLFormElement>, brand: WorkbookBrand) {
    event.preventDefault();
    const name = editingName.trim();
    if (!name) { setError('品牌名称不能为空。'); return; }
    setError('');
    updateMutation.mutate({ brandId: brand.id, name, expectedVersion: brand.version });
  }

  function changeActive(brand: WorkbookBrand) {
    const nextActive = !brand.active;
    const otherActiveBrands = (brandsQuery.data?.brands ?? []).filter((item) => item.id !== brand.id && item.active && !isUnavailableDemoBrand(item));
    if (!nextActive && brand.id === currentBrandId && otherActiveBrands.length === 0) {
      setError('当前品牌是唯一启用品牌。先启用或创建另一个品牌，再停用当前品牌。');
      return;
    }
    setError('');
    updateMutation.mutate({ brandId: brand.id, active: nextActive, expectedVersion: brand.version });
  }

  function startNewMember() {
    memberMutation.reset();
    setMemberMessage('');
    setMemberConflict(false);
    setMemberDraft({ principalId: null, displayName: '', businessOwnerName: '', active: true, expectedVersion: 0 });
  }

  function editMember(member: WorkbookBrandMember) {
    memberMutation.reset();
    setMemberMessage('');
    setMemberConflict(false);
    setMemberDraft({
      principalId: member.principalId,
      displayName: member.displayName,
      businessOwnerName: member.businessOwnerName ?? '',
      active: member.active,
      expectedVersion: member.version,
    });
  }

  function selectMember(principalId: string | null, displayName?: string) {
    if (!principalId) {
      setMemberDraft((current) => current ? { ...current, principalId: null, displayName: '' } : current);
      return;
    }
    const existing = members.find((member) => member.principalId === principalId);
    setMemberDraft((current) => ({
      principalId,
      displayName: displayName ?? existing?.displayName ?? current?.displayName ?? '',
      businessOwnerName: existing?.businessOwnerName ?? current?.businessOwnerName ?? '',
      active: existing?.active ?? current?.active ?? true,
      expectedVersion: existing?.version ?? current?.expectedVersion ?? 0,
    }));
  }

  function submitMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!currentBrandId || !memberDraft) return;
    if (!memberDraft.principalId || !memberDraft.displayName.trim()) {
      setMemberMessage('请选择成员账号。');
      return;
    }
    const input: WorkbookBrandMemberInput = {
      principalId: memberDraft.principalId,
      displayName: memberDraft.displayName.trim(),
      businessOwnerName: memberDraft.businessOwnerName.trim() || null,
      active: memberDraft.active,
      expectedVersion: memberDraft.expectedVersion,
    };
    setMemberMessage('');
    memberMutation.mutate({ brandId: currentBrandId, input });
  }

  async function refreshMemberList() {
    const result = await membersQuery.refetch();
    if (result.error) {
      setMemberMessage(result.error instanceof Error ? `成员列表刷新失败：${result.error.message}` : '成员列表刷新失败。');
      return;
    }
    memberMutation.reset();
    setMemberConflict(false);
    setMemberMessage('成员列表已刷新。');
    setMemberDraft(null);
  }

  function toggleMemberActive(member: WorkbookBrandMember) {
    if (!currentBrandId) return;
    memberMutation.reset();
    const input: WorkbookBrandMemberInput = {
      principalId: member.principalId,
      displayName: member.displayName,
      businessOwnerName: member.businessOwnerName,
      active: !member.active,
      expectedVersion: member.version,
    };
    setMemberMessage('');
    setMemberConflict(false);
    memberMutation.mutate({ brandId: currentBrandId, input });
  }

  if (!isManager) return <div className="page-stack brand-management-page">
    <PageHeading title="品牌管理" />
    <div className="notice notice-warning"><ShieldCheck size={15} /><span>你没有品牌管理权限，请联系管理员开通。</span></div>
  </div>;

  const brands = (brandsQuery.data?.brands ?? session.brands ?? []).filter((brand) => !isUnavailableDemoBrand(brand));
  const members = membersQuery.data?.members ?? [];
  const listLoading = brandsQuery.isLoading;
  const setupMode = !currentBrandId;
  const ownerAliases = workbook?.storage === 'cloud'
    ? [...new Set(workbook.availableBusinessOwners.map((value) => value.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right, 'zh-CN'))
    : [];

  return <div className="page-stack brand-management-page">
    <PageHeading title={setupMode ? '创建品牌' : '品牌管理'} />

    <Panel title="品牌列表" description={setupMode ? '先创建品牌，再进入对应工作区。' : `当前工作区：${workbook?.brandName ?? '—'}`} action={<Button size="sm" variant="outline" onClick={() => void brandsQuery.refetch()} disabled={listLoading}><RefreshCw size={14} />刷新</Button>}>
      <div className="brand-management-list">
        {brands.map((brand) => <article className={`brand-management-row${brand.id === currentBrandId ? ' is-current' : ''}${brand.active ? '' : ' is-inactive'}`} key={brand.id}>
          <div className="brand-management-main">
            <span className="brand-management-icon"><Building2 size={17} /></span>
            {editingBrandId === brand.id ? <form className="brand-rename-form" onSubmit={(event) => submitRename(event, brand)}>
              <Input aria-label="品牌名称" value={editingName} maxLength={80} onChange={(event) => setEditingName(event.target.value)} autoFocus />
              <Button size="icon" type="submit" aria-label="保存品牌名称" disabled={updateMutation.isPending}><Check size={15} /></Button>
              <Button size="icon" type="button" variant="ghost" aria-label="取消编辑" onClick={() => { setEditingBrandId(''); setEditingName(''); }}><X size={15} /></Button>
            </form> : <div className="brand-management-name"><strong>{brand.name}</strong><span className={`brand-status${brand.active ? ' is-active' : ''}`}>{brand.active ? '已启用' : '已停用'}</span>{brand.id === currentBrandId && <span className="brand-current-tag">当前品牌</span>}</div>}
          </div>
          <div className="brand-management-actions">
            {brand.active && brand.id !== currentBrandId && <Button size="sm" variant="outline" onClick={() => openBrand(brand.id)}>进入品牌<ArrowRight size={14} /></Button>}
            <Button size="sm" variant="ghost" onClick={() => { setEditingBrandId(brand.id); setEditingName(brand.name); setError(''); }} disabled={updateMutation.isPending}><Pencil size={14} />改名</Button>
            <Button size="sm" variant="ghost" className={brand.active ? 'brand-deactivate-button' : 'brand-activate-button'} onClick={() => changeActive(brand)} disabled={updateMutation.isPending}>{brand.active ? '停用' : '重新启用'}</Button>
          </div>
        </article>)}
        {!listLoading && brands.length === 0 && <EmptyState title="还没有品牌" description="创建品牌后，可在这里管理成员。" icon={<Building2 size={20} />} />}
        {listLoading && <div className="brand-management-loading" role="status">正在加载品牌…</div>}
        {brandsQuery.isError && <div className="notice notice-error" role="alert">{brandsQuery.error instanceof Error ? brandsQuery.error.message : '品牌列表加载失败。'}<Button size="sm" variant="outline" onClick={() => void brandsQuery.refetch()}>重试</Button></div>}
      </div>
      {error && <div className="notice notice-error brand-management-error" role="alert">{error}</div>}
      <form className="brand-create-form" onSubmit={submitCreate}>
        <FormField label="新增品牌" hint="停用的品牌可重新启用，历史记录会保留。">
          <div className="brand-create-controls"><Input value={newName} maxLength={80} onChange={(event) => setNewName(event.target.value)} placeholder="输入品牌名称" autoComplete="off" /><Button type="submit" disabled={createMutation.isPending || !newName.trim()}><Plus size={15} />{createMutation.isPending ? '创建中…' : '创建品牌'}</Button></div>
        </FormField>
      </form>
    </Panel>

    {currentBrandId && <Panel title="品牌成员" description="管理当前品牌的成员账号和商务归属。" action={<Button size="sm" onClick={startNewMember} disabled={memberMutation.isPending || memberConflict || Boolean(memberDraft)}><Plus size={14} />添加成员</Button>}>
      {memberConflict && <div className="notice notice-warning brand-management-error" role="alert"><span>{memberMessage}</span><Button size="sm" variant="outline" onClick={() => void refreshMemberList()} disabled={membersQuery.isFetching}><RefreshCw size={13} />刷新成员列表</Button></div>}
      {!memberConflict && memberMessage && <div className={memberMutation.isError ? 'notice notice-error brand-management-error' : 'notice notice-info brand-management-error'} role="status">{memberMessage}</div>}
      {membersQuery.isLoading ? <div className="brand-management-loading" role="status">正在加载成员…</div>
        : membersQuery.isError ? <div className="notice notice-error" role="alert">{membersQuery.error instanceof Error ? membersQuery.error.message : '成员列表加载失败。'}<Button size="sm" variant="outline" onClick={() => void membersQuery.refetch()}>重试</Button></div>
          : members.length ? <div className="brand-members-list">{members.map((member) => <article className="brand-member-row" key={member.id}>
            <span className="brand-member-icon"><UserRound size={15} /></span><span className="brand-member-name"><strong>{member.displayName}</strong><small>{member.businessOwnerName ? `商务名称：${member.businessOwnerName}` : '未绑定商务归属（非商务岗位可不填）'}</small></span><span className={`brand-status${member.active ? ' is-active' : ''}`}>{member.active ? '已启用' : '已停用'}</span>
            <div className="brand-member-actions"><Button size="sm" variant="outline" onClick={() => editMember(member)} disabled={memberMutation.isPending || memberConflict || Boolean(memberDraft)}>编辑</Button><Button size="sm" variant="ghost" className={member.active ? 'brand-deactivate-button' : 'brand-activate-button'} onClick={() => toggleMemberActive(member)} disabled={memberMutation.isPending || memberConflict || Boolean(memberDraft)}>{member.active ? '停用成员' : '恢复成员'}</Button></div>
          </article>)}</div>
            : <EmptyState title="当前品牌还没有成员" description="添加或邀请成员，并管理其品牌访问范围。" />}

      {memberDraft && <form className="brand-member-editor" onSubmit={submitMember}>
        <div className="brand-member-editor-heading"><div><h3>{memberDraft.expectedVersion === 0 ? '添加成员' : '编辑成员'}</h3></div><Button size="icon" type="button" variant="ghost" aria-label="关闭成员表单" onClick={() => { setMemberDraft(null); setMemberMessage(''); }} disabled={memberMutation.isPending}><X size={15} /></Button></div>
        <FormField label="成员账号" required>
          <UserSelect
            accountType="apaas"
            valueType="string"
            multiple={false}
            value={memberDraft.principalId}
            onChange={(value) => selectMember(value)}
            onSelect={(item) => selectMember(item.id, item.name)}
            disabled={memberDraft.expectedVersion > 0 || memberMutation.isPending}
            placeholder="搜索并选择成员账号"
          />
          {memberDraft.displayName && <small className="brand-member-selected-name">已选择：{memberDraft.displayName}</small>}
        </FormField>
        <FormField label="商务名称" hint="商务岗位必填，可选择来源资料中的名称。">
          {ownerAliases.length ? <select className="native-select" value={memberDraft.businessOwnerName} onChange={(event) => setMemberDraft((current) => current ? { ...current, businessOwnerName: event.target.value } : current)} disabled={memberMutation.isPending}>
            <option value="">暂不绑定商务姓名</option>
            {memberDraft.businessOwnerName && !ownerAliases.includes(memberDraft.businessOwnerName) && <option value={memberDraft.businessOwnerName}>{memberDraft.businessOwnerName}（当前映射）</option>}
            {ownerAliases.map((alias) => <option key={alias} value={alias}>{alias}</option>)}
          </select> : <Input value={memberDraft.businessOwnerName} onChange={(event) => setMemberDraft((current) => current ? { ...current, businessOwnerName: event.target.value } : current)} placeholder="填写商务名称" disabled={memberMutation.isPending} />}
        </FormField>
        <label className="brand-member-active-control"><input type="checkbox" checked={memberDraft.active} onChange={(event) => setMemberDraft((current) => current ? { ...current, active: event.target.checked } : current)} disabled={memberMutation.isPending} /><span>启用成员</span><small>停用后历史记录保留，可随时恢复。</small></label>
        <div className="brand-member-editor-footer"><Button type="button" variant="outline" onClick={() => setMemberDraft(null)} disabled={memberMutation.isPending}>取消</Button><Button type="submit" disabled={memberMutation.isPending || memberConflict || !memberDraft.principalId || !memberDraft.displayName.trim()}>{memberMutation.isPending ? '保存中…' : memberDraft.expectedVersion === 0 ? '添加成员' : '保存修改'}</Button></div>
      </form>}
    </Panel>}

    {currentBrandId && <MemberInvitationsPanel currentBrandId={currentBrandId} brands={brands} />}
  </div>;
}
