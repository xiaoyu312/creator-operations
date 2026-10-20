import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Link2, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  INVITATION_ROLES,
  INVITATION_ROLE_LABELS,
  type CreateInvitationInput,
  type InvitationRole,
  type MemberInvitation,
} from '@shared/invitations';
import type { WorkbookBrand } from '@shared/brands';
import { ApiError, approveMemberInvitation, createMemberInvitation, listMemberInvitations, memberInvitationUrl, recoverMemberInvitation, revokeMemberInvitation } from '../api';
import { invitationActions, approvalOutcome, invitationStatusLabel } from '../lib/member-invitations';
import { brandNavigationUrl } from '../lib/workbook-context';
import { UserDisplay } from './business-ui/user-display';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { EmptyState, FormField, Modal, Panel } from './workbench';
import '../member-invitations.css';

interface MemberInvitationsPanelProps {
  currentBrandId: string;
  brands: WorkbookBrand[];
}

interface InvitationDraft {
  recipientName: string;
  role: InvitationRole;
  brandIds: string[];
  businessOwnerNames: Record<string, string>;
  expiresInDays: 1 | 3 | 7;
}

const INVITATIONS_QUERY_KEY = ['member-invitations'] as const;

function defaultDraft(currentBrandId: string): InvitationDraft {
  return {
    recipientName: '',
    role: 'bd',
    brandIds: [currentBrandId],
    businessOwnerNames: {},
    expiresInDays: 3,
  };
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function isVersionConflict(error: unknown) {
  return error instanceof ApiError && error.code === 'VERSION_CONFLICT';
}

function claimantIdentity(invitation: MemberInvitation, localPreview: boolean) {
  const claimant = invitation.claimant;
  if (!claimant) return <span className="invitation-empty-claimant">尚未领取</span>;
  return <span className="invitation-claimant">
    {localPreview
      ? <strong>{claimant.displayName}</strong>
      : <><UserDisplay value={claimant.principalId} size="small" /><span>{claimant.displayName}</span></>}
    <small>{claimant.userType === 'external' ? '飞书外部账号' : '飞书内部账号'}</small>
  </span>;
}

function InvitationStatus({ invitation }: { invitation: MemberInvitation }) {
  const tone = invitation.status === 'completed' ? 'green'
    : invitation.status === 'provision_failed' || invitation.status === 'expired' || invitation.status === 'revoked' ? 'red'
      : invitation.status === 'claimed' || invitation.status === 'provisioning' ? 'orange' : 'blue';
  return <span className={`status-pill status-${tone}`}>{invitationStatusLabel(invitation.status)}</span>;
}

export default function MemberInvitationsPanel({ currentBrandId, brands }: MemberInvitationsPanelProps) {
  const queryClient = useQueryClient();
  const linkInputRef = useRef<HTMLInputElement>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<InvitationDraft>(() => defaultDraft(currentBrandId));
  const [createdLink, setCreatedLink] = useState('');
  const [createdLinkError, setCreatedLinkError] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const [approvalCandidate, setApprovalCandidate] = useState<MemberInvitation | null>(null);
  const [identityConfirmed, setIdentityConfirmed] = useState(false);
  const [approvalMessage, setApprovalMessage] = useState('');
  const [revokeCandidate, setRevokeCandidate] = useState<MemberInvitation | null>(null);
  const [recoverCandidate, setRecoverCandidate] = useState<MemberInvitation | null>(null);
  const [panelMessage, setPanelMessage] = useState('');
  const [panelError, setPanelError] = useState('');

  const directoryQuery = useQuery({
    queryKey: INVITATIONS_QUERY_KEY,
    queryFn: listMemberInvitations,
    retry: false,
    staleTime: 10_000,
  });
  const directory = directoryQuery.data;
  const readiness = directory?.readiness;
  const localPreview = readiness?.localPreview === true;
  const activeBrands = brands.filter((brand) => brand.active);
  const availableRoles = (directory?.availableRoles ?? []).filter((role) => (INVITATION_ROLES as readonly string[]).includes(role));

  useEffect(() => {
    if (availableRoles.length && !availableRoles.includes(draft.role)) {
      setDraft((current) => ({ ...current, role: availableRoles[0]! }));
    }
  }, [availableRoles, draft.role]);

  const createMutation = useMutation({
    mutationFn: (input: CreateInvitationInput) => createMemberInvitation(input),
    onSuccess: async (result) => {
      setCreatedLinkError('');
      setCopyStatus('');
      try {
        setCreatedLink(memberInvitationUrl(result.invitationPath));
      } catch {
        setCreatedLink('');
        setCreatedLinkError('邀请已创建，但返回的链接格式异常。请先刷新列表核对邀请，不要重复创建。');
      }
      await queryClient.invalidateQueries({ queryKey: INVITATIONS_QUERY_KEY });
    },
    onError: (error) => setPanelError(errorMessage(error, '邀请创建失败，请检查填写内容后重试。')),
  });

  const approveMutation = useMutation({
    mutationFn: ({ id, version }: { id: string; version: number }) => approveMemberInvitation(id, version),
    onSuccess: async (updated) => {
      await queryClient.invalidateQueries({ queryKey: INVITATIONS_QUERY_KEY });
      const outcome = approvalOutcome(updated);
      if (outcome === 'completed') {
        await Promise.all(updated.brands.map((brand) => queryClient.invalidateQueries({ queryKey: ['workbook-brand-members', brand.brandId] })));
        setApprovalCandidate(null);
        setIdentityConfirmed(false);
        setApprovalMessage(localPreview
          ? '本机模拟开通已完成。真实飞书账号的登录与工作区访问需发布后另行验证。'
          : '成员权限已开通，可在品牌成员管理中查看。领取人请刷新邀请状态；如品牌入口仍不可用，可重新登录后再检查。');
        setPanelMessage(localPreview ? '本机模拟邀请流程已完成。' : '邀请开通完成。');
        setPanelError('');
        return;
      }
      setApprovalCandidate(updated);
      setIdentityConfirmed(false);
      if (outcome === 'partial') {
        setApprovalMessage(updated.issue ?? '平台岗位已授予，但品牌绑定尚未完成。状态仍未完成，请核对品牌后重新确认并重试。');
      } else if (outcome === 'failed') {
        setApprovalMessage(updated.issue ?? '平台岗位尚未完成核验。状态仍未完成，请重新确认后重试。');
      } else if (outcome === 'processing') {
        setApprovalMessage('开通仍在处理中，尚未标记完成。请刷新状态后再决定是否重试。');
      } else {
        setApprovalMessage('服务端未返回已完成状态，请刷新邀请列表核对结果。');
      }
      setPanelMessage('邀请尚未完成开通。');
      setPanelError('');
    },
    onError: async (error) => {
      if (isVersionConflict(error)) {
        setApprovalCandidate(null);
        setIdentityConfirmed(false);
        setApprovalMessage('邀请状态或版本已变化，已刷新列表。请核对最新领取账号后，再手动发起确认。');
        setPanelError('邀请状态已变化，本次没有自动重试开通。');
        await queryClient.invalidateQueries({ queryKey: INVITATIONS_QUERY_KEY });
        return;
      }
      setApprovalMessage(errorMessage(error, '邀请开通失败，请刷新状态后重试。'));
    },
  });

  const revokeMutation = useMutation({
    mutationFn: ({ id, version }: { id: string; version: number }) => revokeMemberInvitation(id, version),
    onSuccess: async () => {
      setRevokeCandidate(null);
      setPanelMessage('邀请链接已撤销。已完成的成员权限不会因撤销邀请而移除。');
      setPanelError('');
      await queryClient.invalidateQueries({ queryKey: INVITATIONS_QUERY_KEY });
    },
    onError: async (error) => {
      setRevokeCandidate(null);
      if (isVersionConflict(error)) {
        setPanelError('邀请状态已变化，本次没有自动重试撤销；列表已刷新，请核对最新状态。');
        await queryClient.invalidateQueries({ queryKey: INVITATIONS_QUERY_KEY });
        return;
      }
      setPanelError(errorMessage(error, '邀请撤销失败，请刷新状态后重试。'));
    },
  });

  const recoverMutation = useMutation({
    mutationFn: ({ id, version }: { id: string; version: number }) => recoverMemberInvitation(id, version),
    onSuccess: async () => {
      setRecoverCandidate(null);
      setPanelMessage('此次未完成开通已结束，邀请状态已刷新。已配置岗位不会自动撤回，请按需在平台岗位管理中单独核对。');
      setPanelError('');
      await queryClient.invalidateQueries({ queryKey: INVITATIONS_QUERY_KEY });
    },
    onError: async (error) => {
      setRecoverCandidate(null);
      if (isVersionConflict(error)) {
        setPanelError('邀请状态已变化，本次没有自动重试处理；列表已刷新，请核对最新状态。');
        await queryClient.invalidateQueries({ queryKey: INVITATIONS_QUERY_KEY });
        return;
      }
      setPanelError(errorMessage(error, '结束未完成开通失败，请刷新状态后重试。'));
    },
  });

  function openCreate() {
    setDraft(defaultDraft(currentBrandId));
    setCreatedLink('');
    setCreatedLinkError('');
    setCopyStatus('');
    setPanelMessage('');
    setPanelError('');
    createMutation.reset();
    setCreateOpen(true);
  }

  function closeCreate(open: boolean) {
    if (createMutation.isPending) return;
    setCreateOpen(open);
    if (!open) {
      setCreatedLink('');
      setCreatedLinkError('');
      setCopyStatus('');
      createMutation.reset();
    }
  }

  function toggleBrand(brandId: string) {
    setDraft((current) => ({
      ...current,
      brandIds: current.brandIds.includes(brandId)
        ? current.brandIds.filter((id) => id !== brandId)
        : [...current.brandIds, brandId],
    }));
  }

  function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const recipientName = draft.recipientName.trim();
    const selectedBrands = activeBrands.filter((brand) => draft.brandIds.includes(brand.id));
    if (!readiness?.canCreate) {
      setPanelError(readiness?.message ?? '服务端尚未确认可安全创建邀请。');
      return;
    }
    if (!recipientName) { setPanelError('请填写邀请对象姓名。'); return; }
    if (!availableRoles.includes(draft.role)) { setPanelError('此岗位当前不可邀请，请刷新后重试。'); return; }
    if (!selectedBrands.length) { setPanelError('至少选择一个启用中的品牌。'); return; }
    if (draft.role === 'bd' && selectedBrands.some((brand) => !draft.businessOwnerNames[brand.id]?.trim())) {
      setPanelError('请为每个所选品牌填写商务名称。');
      return;
    }
    const input: CreateInvitationInput = {
      recipientName,
      role: draft.role,
      brands: selectedBrands.map((brand) => ({
        brandId: brand.id,
        businessOwnerName: draft.role === 'bd' ? draft.businessOwnerNames[brand.id]!.trim() : null,
      })),
      expiresInDays: draft.expiresInDays,
    };
    setPanelError('');
    setPanelMessage('');
    createMutation.mutate(input);
  }

  async function copyCreatedLink() {
    if (!createdLink) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(createdLink);
      setCopyStatus('已复制。邀请链接仅在此处显示一次，请及时保存并转交本人。');
    } catch {
      setCopyStatus('无法自动复制。请点击链接框，手动全选并复制；邀请链接仅在此处显示一次。');
      requestAnimationFrame(() => {
        linkInputRef.current?.focus();
        linkInputRef.current?.select();
      });
    }
  }

  async function refreshInvitations() {
    setPanelError('');
    const result = await directoryQuery.refetch();
    if (result.error) setPanelError(errorMessage(result.error, '邀请列表刷新失败。'));
    else setPanelMessage('邀请列表已刷新。');
  }

  function beginApproval(invitation: MemberInvitation) {
    setPanelMessage('');
    setPanelError('');
    setIdentityConfirmed(false);
    setApprovalMessage('');
    setApprovalCandidate(invitation);
  }

  async function confirmApproval() {
    if (!approvalCandidate || !identityConfirmed || !invitationActions(approvalCandidate.actions).canApprove || !readiness?.canApprove || approveMutation.isPending) return;
    setApprovalMessage(approvalCandidate.status === 'provisioning' ? '正在重新核验岗位…' : '正在核验并开通…');
    approveMutation.mutate({ id: approvalCandidate.id, version: approvalCandidate.version });
  }

  function beginRevoke(invitation: MemberInvitation) {
    setPanelMessage('');
    setPanelError('');
    setRevokeCandidate(invitation);
  }

  function confirmRevoke() {
    if (!revokeCandidate || revokeMutation.isPending || !invitationActions(revokeCandidate.actions).canRevoke) return;
    revokeMutation.mutate({ id: revokeCandidate.id, version: revokeCandidate.version });
  }

  function beginRecovery(invitation: MemberInvitation) {
    setPanelMessage('');
    setPanelError('');
    setRecoverCandidate(invitation);
  }

  function confirmRecovery() {
    if (!recoverCandidate || recoverMutation.isPending || !invitationActions(recoverCandidate.actions).canRecover) return;
    recoverMutation.mutate({ id: recoverCandidate.id, version: recoverCandidate.version });
  }

  const invitations = directory?.invitations ?? [];

  return <>
    <Panel
      title="成员邀请"
      description="先预登记岗位与品牌范围，领取后由管理员核对真实飞书账号并确认开通。"
      className="member-invitations-panel"
      action={<>
        <Button size="sm" variant="outline" onClick={() => void refreshInvitations()} disabled={directoryQuery.isFetching} aria-label="刷新成员邀请列表">
          <RefreshCw size={14} className={directoryQuery.isFetching ? 'invitation-refreshing' : ''} />刷新
        </Button>
        <Button size="sm" onClick={openCreate} disabled={!readiness?.canCreate || !availableRoles.length || !activeBrands.length}>
          <Plus size={14} />邀请同事
        </Button>
      </>}
    >
      {directoryQuery.isLoading && <div className="invitation-loading" role="status">正在读取邀请权限与列表…</div>}
      {directoryQuery.isError && <div className="notice notice-error invitation-notice" role="alert">
        <span>{errorMessage(directoryQuery.error, '成员邀请列表读取失败。')}</span>
        <Button size="sm" variant="outline" onClick={() => void refreshInvitations()} disabled={directoryQuery.isFetching}>重试</Button>
      </div>}
      {directory && readiness && (!readiness.canCreate || !readiness.canApprove) && <div className="notice notice-warning invitation-notice" role="status">
        <ShieldCheck size={15} /><span>{readiness.message ?? '当前环境未通过安全核验。'}{!readiness.canCreate ? ' 不能创建邀请。' : ''}{!readiness.canApprove ? ' 不能确认开通。' : ''}</span>
      </div>}
      {localPreview && <div className="notice notice-warning invitation-notice" role="status">
        <ShieldCheck size={15} /><span>本机模拟邀请流程，不代表真实飞书登录、权限授予或生产可用。</span>
      </div>}
      {panelError && <div className="notice notice-error invitation-notice" role="alert">{panelError}</div>}
      {panelMessage && <div className="notice notice-info invitation-notice" role="status">{panelMessage}</div>}

      {directoryQuery.isSuccess && invitations.length > 0 && <div className="invitation-list">
        {invitations.map((invitation) => {
          const actions = invitationActions(invitation.actions);
          return <article className="invitation-row" key={invitation.id}>
            <div className="invitation-row-main">
              <div className="invitation-row-title">
                <strong>{invitation.recipientName}</strong>
                <span className="invitation-role">{INVITATION_ROLE_LABELS[invitation.role]}</span>
                <InvitationStatus invitation={invitation} />
              </div>
              <div className="invitation-row-details">
                <div><span>品牌</span><div className="invitation-brand-chips">{invitation.brands.map((brand) => <span className="invitation-brand-chip" key={brand.brandId}>
                  {brand.brandName}{invitation.role === 'bd' && brand.businessOwnerName ? ` · ${brand.businessOwnerName}` : ''}
                </span>)}</div></div>
                <div><span>到期</span><strong>{new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(invitation.expiresAt))}</strong></div>
                <div><span>领取账号</span>{claimantIdentity(invitation, localPreview)}</div>
              </div>
              {invitation.status === 'provision_failed' && <p className="invitation-issue" role="status">
                {invitation.issue ?? (invitation.roleGranted ? '平台岗位已授予，但成员绑定尚未完成。' : '平台岗位尚未完成核验。')}
                {' '}当前状态未完成，可核对后重试。
              </p>}
              {invitation.status === 'completed' && <p className="invitation-complete-note">权限已开通；如需调整，请到对应品牌成员管理。</p>}
            </div>
            <div className="invitation-row-actions">
              {actions.canApprove && <Button size="sm" onClick={() => beginApproval(invitation)} disabled={!readiness?.canApprove || approveMutation.isPending}>
                {invitation.status === 'provisioning' ? '重试核验' : invitation.status === 'provision_failed' ? '重试开通' : '核验并开通'}
              </Button>}
              {actions.canRevoke && <Button size="sm" variant="outline" className="invitation-revoke-button" onClick={() => beginRevoke(invitation)} disabled={revokeMutation.isPending}>撤销邀请</Button>}
              {actions.canRecover && <Button size="sm" variant="outline" onClick={() => beginRecovery(invitation)} disabled={recoverMutation.isPending}>处理超时</Button>}
              {invitation.status === 'completed' && <Button size="sm" variant="outline" onClick={() => {
                const firstBrandId = invitation.brands[0]?.brandId;
                if (firstBrandId) window.location.assign(brandNavigationUrl(window.location.href, firstBrandId));
              }} disabled={!invitation.brands[0]?.brandId}>品牌成员管理</Button>}
            </div>
          </article>;
        })}
      </div>}
      {directoryQuery.isSuccess && invitations.length === 0 && <EmptyState title="暂无成员邀请" description="邀请同事后，领取和开通状态会显示在这里。" icon={<Link2 size={20} />} />}
    </Panel>

    <Modal
      open={createOpen}
      onOpenChange={closeCreate}
      title={createdLink ? '邀请链接已生成' : '邀请同事'}
      description={createdLink ? '链接只在本次创建成功后显示；请交给预登记对象本人。' : '先确认岗位、品牌和有效期。链接领取后仍需管理员核验账号并开通。'}
      className="modal-wide invitation-modal"
    >
      {createdLink ? <div className="invitation-created-result">
        <div className="notice notice-warning"><Link2 size={15} /><span>完整链接仅展示一次。请及时复制并通过安全渠道交给预登记对象本人。</span></div>
        <FormField label="单人邀请链接" hint="打开后需使用本人飞书账号登录，并手动确认领取。">
          <Input ref={linkInputRef} className="invitation-link-input" value={createdLink} readOnly aria-label="单人邀请链接" onFocus={(event) => event.currentTarget.select()} onClick={(event) => event.currentTarget.select()} />
        </FormField>
        {createdLinkError && <div className="notice notice-error" role="alert">{createdLinkError}</div>}
        {copyStatus && <div className="notice notice-info" role="status">{copyStatus}</div>}
        <div className="modal-actions"><Button type="button" onClick={() => void copyCreatedLink()}><Copy size={14} />复制链接</Button><Button type="button" variant="outline" onClick={() => closeCreate(false)}>完成</Button></div>
      </div> : createdLinkError ? <div className="invitation-created-result">
        <div className="notice notice-error" role="alert">{createdLinkError}</div>
        <div className="modal-actions"><Button type="button" variant="outline" onClick={() => closeCreate(false)}>关闭</Button></div>
      </div> : <form className="modal-form invitation-create-form" onSubmit={submitCreate}>
        <FormField label="邀请对象姓名" required hint="只用于管理员核对，不作为登录身份验证。">
          <Input autoFocus value={draft.recipientName} maxLength={120} autoComplete="off" onChange={(event) => setDraft((current) => ({ ...current, recipientName: event.target.value }))} placeholder="填写同事姓名" disabled={createMutation.isPending} />
        </FormField>
        <div className="form-grid invitation-form-grid">
          <FormField label="岗位" required>
            <select className="native-select" value={draft.role} onChange={(event) => setDraft((current) => ({ ...current, role: event.target.value as InvitationRole }))} disabled={createMutation.isPending}>
              {availableRoles.map((role) => <option key={role} value={role}>{INVITATION_ROLE_LABELS[role]}</option>)}
            </select>
          </FormField>
          <FormField label="有效期" required>
            <select className="native-select" value={draft.expiresInDays} onChange={(event) => setDraft((current) => ({ ...current, expiresInDays: Number(event.target.value) as 1 | 3 | 7 }))} disabled={createMutation.isPending}>
              <option value={1}>1 天</option><option value={3}>3 天</option><option value={7}>7 天</option>
            </select>
          </FormField>
        </div>
        <fieldset className="invitation-brand-picker" disabled={createMutation.isPending}>
          <legend>授权品牌 <span>可多选，默认当前品牌</span></legend>
          {activeBrands.length ? <div className="invitation-brand-options">{activeBrands.map((brand) => <label className="invitation-brand-option" key={brand.id}>
            <input type="checkbox" checked={draft.brandIds.includes(brand.id)} onChange={() => toggleBrand(brand.id)} />
            <span>{brand.name}{brand.id === currentBrandId ? '（当前）' : ''}</span>
          </label>)}</div> : <p className="invitation-field-note">当前没有可授权的启用品牌。</p>}
        </fieldset>
        {draft.role === 'bd' && <div className="invitation-business-names">
          <div className="invitation-section-caption"><strong>各品牌商务名称</strong><span>每个所选品牌都需要填写。</span></div>
          {activeBrands.filter((brand) => draft.brandIds.includes(brand.id)).map((brand) => <FormField key={brand.id} label={`${brand.name} 商务名称`} required>
            <Input value={draft.businessOwnerNames[brand.id] ?? ''} maxLength={120} autoComplete="off" onChange={(event) => setDraft((current) => ({ ...current, businessOwnerNames: { ...current.businessOwnerNames, [brand.id]: event.target.value } }))} placeholder="填写该品牌下的商务名称" disabled={createMutation.isPending} />
          </FormField>)}
        </div>}
        {panelError && <div className="notice notice-error" role="alert">{panelError}</div>}
        <div className="modal-actions invitation-form-actions">
          <Button type="button" variant="outline" onClick={() => closeCreate(false)} disabled={createMutation.isPending}>取消</Button>
          <Button type="submit" disabled={createMutation.isPending || !readiness?.canCreate || !draft.recipientName.trim() || !draft.brandIds.some((id) => activeBrands.some((brand) => brand.id === id))}>
            {createMutation.isPending ? '生成中…' : '生成单人邀请链接'}
          </Button>
        </div>
      </form>}
    </Modal>

    <Modal
      open={Boolean(approvalCandidate)}
      onOpenChange={(open) => { if (!open && !approveMutation.isPending) { setApprovalCandidate(null); setIdentityConfirmed(false); setApprovalMessage(''); } }}
      title={approvalCandidate?.status === 'provisioning' ? '核对后重试核验' : approvalCandidate?.status === 'provision_failed' ? '核对后重试开通' : '核对领取账号并开通'}
      description="预登记姓名只是提示。请并列核对本人登录账号、岗位和品牌范围后再确认。"
      className="modal-standard invitation-modal"
    >
      {approvalCandidate && <div className="invitation-approval-content">
        <dl className="invitation-identity-list">
          <div><dt>预登记对象</dt><dd>{approvalCandidate.recipientName}</dd></div>
          <div><dt>真实领取账号</dt><dd>{claimantIdentity(approvalCandidate, localPreview)}</dd></div>
          <div><dt>待授予岗位</dt><dd>{INVITATION_ROLE_LABELS[approvalCandidate.role]}</dd></div>
          <div><dt>授权品牌</dt><dd className="invitation-brand-chips">{approvalCandidate.brands.map((brand) => <span className="invitation-brand-chip" key={brand.brandId}>
            {brand.brandName}{approvalCandidate.role === 'bd' && brand.businessOwnerName ? ` · ${brand.businessOwnerName}` : ''}
          </span>)}</dd></div>
        </dl>
        {approvalCandidate.status === 'provision_failed' && <div className="notice notice-warning" role="status">
          <ShieldCheck size={15} /><span>{approvalCandidate.issue ?? '上次开通未完成。请按服务端状态重试；不会自动撤销领取账号已有岗位。'}</span>
        </div>}
        {approvalCandidate.status === 'provisioning' && invitationActions(approvalCandidate.actions).canApprove && <div className="notice notice-warning" role="status">
          <ShieldCheck size={15} /><span>上次开通任务已超时。重试会重新核验平台岗位；此前可能已配置的岗位不会自动撤回。</span>
        </div>}
        {readiness && !readiness.canApprove && <div className="notice notice-warning" role="status">{readiness.message ?? '当前环境不能核验平台岗位范围，无法开通。'}</div>}
        {approvalMessage && <div className={approvalCandidate.status === 'provision_failed' ? 'notice notice-warning' : 'notice notice-info'} role="status">{approvalMessage}</div>}
        <label className="invitation-confirm-check">
          <input type="checkbox" checked={identityConfirmed} onChange={(event) => setIdentityConfirmed(event.target.checked)} disabled={approveMutation.isPending} />
          <span>我已确认真实领取账号与预登记对象一致，并同意开通上方列出的岗位和品牌权限。</span>
        </label>
        <div className="modal-actions">
          <Button type="button" variant="outline" onClick={() => { setApprovalCandidate(null); setIdentityConfirmed(false); setApprovalMessage(''); }} disabled={approveMutation.isPending}>取消</Button>
          <Button type="button" onClick={() => void confirmApproval()} disabled={!identityConfirmed || !invitationActions(approvalCandidate.actions).canApprove || !readiness?.canApprove || approveMutation.isPending}>
            {approveMutation.isPending ? '核验中…' : approvalCandidate.status === 'provisioning' ? '确认重试核验' : approvalCandidate.status === 'provision_failed' ? '确认重试开通' : '确认开通'}
          </Button>
        </div>
      </div>}
    </Modal>

    <Modal
      open={Boolean(revokeCandidate)}
      onOpenChange={(open) => { if (!open && !revokeMutation.isPending) setRevokeCandidate(null); }}
      title="撤销成员邀请"
      description="此操作会使未完成的邀请链接失效。"
      className="modal-standard invitation-modal"
    >
      {revokeCandidate && <div className="invitation-revoke-content">
        <p>确认撤销发给 <strong>{revokeCandidate.recipientName}</strong> 的邀请吗？</p>
        <div className="notice notice-warning"><ShieldCheck size={15} /><span>撤销邀请不会移除任何已完成开通的成员权限；已开通成员需到品牌成员管理中单独调整。</span></div>
        <div className="modal-actions">
          <Button type="button" variant="outline" onClick={() => setRevokeCandidate(null)} disabled={revokeMutation.isPending}>保留邀请</Button>
          <Button type="button" variant="destructive" onClick={confirmRevoke} disabled={revokeMutation.isPending}>{revokeMutation.isPending ? '撤销中…' : '确认撤销邀请'}</Button>
        </div>
      </div>}
    </Modal>

    <Modal
      open={Boolean(recoverCandidate)}
      onOpenChange={(open) => { if (!open && !recoverMutation.isPending) setRecoverCandidate(null); }}
      title="结束此次未完成开通"
      description="仅结束超时的未完成流程并记录状态，不会调用岗位授予操作。"
      className="modal-standard invitation-modal"
    >
      {recoverCandidate && <div className="invitation-revoke-content">
        <p>确认结束发给 <strong>{recoverCandidate.recipientName}</strong> 的此次开通流程吗？</p>
        {recoverCandidate.issue && <p>{recoverCandidate.issue}</p>}
        <div className="notice notice-warning"><ShieldCheck size={15} /><span>已配置的平台岗位不会自动撤回。处理后邀请状态会刷新；如需撤销邀请，请根据新状态提供的操作另行处理。</span></div>
        <div className="modal-actions">
          <Button type="button" variant="outline" onClick={() => setRecoverCandidate(null)} disabled={recoverMutation.isPending}>返回</Button>
          <Button type="button" onClick={confirmRecovery} disabled={!invitationActions(recoverCandidate.actions).canRecover || recoverMutation.isPending}>
            {recoverMutation.isPending ? '处理中…' : '确认结束此次开通'}
          </Button>
        </div>
      </div>}
    </Modal>
  </>;
}
