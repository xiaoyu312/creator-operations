import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, Clock3, Link2, LoaderCircle, RefreshCw, ShieldCheck, UserRound } from 'lucide-react';
import { authClient } from '@lark-apaas/client-toolkit/auth';
import { INVITATION_ROLE_LABELS } from '@shared/invitations';
import { ApiError, claimMemberInvitation, getInvitationJoinContext, inspectMemberInvitation } from '../api';
import { resolveInvitationToken, invitationStatusLabel } from '../lib/member-invitations';
import { Button } from '../components/ui/button';
import '../member-invitations.css';

const INVITATION_TOKEN_KEY = 'dabo.member-invitation.token';

function readSessionValue(key: string) {
  try { return window.sessionStorage.getItem(key); } catch { return null; }
}

function writeSessionValue(key: string, value: string) {
  try { window.sessionStorage.setItem(key, value); return true; } catch { return false; }
}

function removeSessionValue(key: string) {
  try { window.sessionStorage.removeItem(key); return true; } catch { return false; }
}

function consumeInvitationToken(hash: string) {
  const resolution = resolveInvitationToken(hash, readSessionValue(INVITATION_TOKEN_KEY));
  let storageBlocked = false;
  if (resolution.hasIncomingInvite) {
    storageBlocked = resolution.token
      ? !writeSessionValue(INVITATION_TOKEN_KEY, resolution.token)
      : !removeSessionValue(INVITATION_TOKEN_KEY);
  }
  if (resolution.shouldClearHash && !storageBlocked) {
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
  }
  return { token: resolution.token, storageBlocked };
}

function invitationFailureMessage(error: unknown) {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : '暂时无法读取邀请，请稍后重试。';
  if (error.code === 'UNAUTHENTICATED') return '请先使用飞书账号登录，再查看或领取这条邀请。';
  if (error.code === 'NOT_FOUND') return '邀请链接无效、已撤销或已失效。请联系邀请管理员确认。';
  if (error.code === 'FORBIDDEN') return '这条邀请已由其他账号领取，当前账号不能领取。';
  if (error.code === 'INVALID_TRANSITION') return '邀请已过期、撤销或当前状态不允许领取。';
  if (error.code === 'VERSION_CONFLICT') return '邀请状态刚刚发生变化，请刷新后查看最新状态。';
  return error.message || '暂时无法读取邀请，请稍后重试。';
}

function isAuthenticationError(error: unknown) {
  return error instanceof ApiError && error.code === 'UNAUTHENTICATED';
}

function friendlyStatusDescription(status: string, claimedByYou: boolean, message: string | null) {
  if (status === 'pending') return message ?? '邀请尚未领取。核对岗位和品牌后，你可以手动提交领取。';
  if (status === 'claimed') return claimedByYou
    ? '已领取，等待管理员核对真实账号并确认开通。'
    : '这条邀请已由其他账号领取，当前登录账号无法继续操作。';
  if (status === 'provisioning') return '管理员正在核验并开通岗位。请稍后刷新状态。';
  if (status === 'provision_failed') return message ?? '管理员开通尚未完成。请联系管理员查看状态并重试。';
  if (status === 'completed') return message ?? '管理员已完成开通，正在核对当前登录账号的工作区权限。';
  if (status === 'revoked') return '这条邀请已撤销，无法继续领取。';
  if (status === 'expired') return '这条邀请已过期，无法继续领取。';
  return message ?? '当前邀请状态暂不可用。';
}

export default function InvitationJoinPage() {
  const queryClient = useQueryClient();
  const [initialCapture] = useState(() => typeof window === 'undefined' ? { token: null, storageBlocked: false } : consumeInvitationToken(window.location.hash));
  const [token, setToken] = useState(initialCapture.token);
  const [tokenStorageBlocked, setTokenStorageBlocked] = useState(initialCapture.storageBlocked);
  const [queryScope] = useState(() => typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const [tokenGeneration, setTokenGeneration] = useState(0);
  const [claimError, setClaimError] = useState('');
  const [pageError, setPageError] = useState('');
  const [loginMessage, setLoginMessage] = useState('');
  const [authActionPending, setAuthActionPending] = useState(false);

  useEffect(() => {
    function handleHashChange() {
      const resolution = resolveInvitationToken(window.location.hash, readSessionValue(INVITATION_TOKEN_KEY));
      if (!resolution.hasIncomingInvite) return;
      const capture = consumeInvitationToken(window.location.hash);
      setToken(capture.token);
      setTokenStorageBlocked(capture.storageBlocked);
      setTokenGeneration((generation) => generation + 1);
      setClaimError('');
      setPageError('');
      setLoginMessage('');
    }
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const contextQuery = useQuery({
    queryKey: ['invitation-join-context', queryScope, tokenGeneration],
    queryFn: getInvitationJoinContext,
    enabled: Boolean(token),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const inspectionQuery = useQuery({
    queryKey: ['invitation-join-view', queryScope, tokenGeneration],
    queryFn: () => token ? inspectMemberInvitation(token) : Promise.reject(new Error('邀请链接无效。')),
    enabled: Boolean(token) && contextQuery.isSuccess,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const claimMutation = useMutation({
    mutationFn: () => token ? claimMemberInvitation(token) : Promise.reject(new Error('邀请链接无效。')),
    onSuccess: (view) => {
      setClaimError('');
      queryClient.setQueryData(['invitation-join-view', queryScope, tokenGeneration], view);
    },
    onError: (error) => {
      setClaimError(invitationFailureMessage(error));
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') void inspectionQuery.refetch();
    },
  });

  async function handleLogin() {
    if (authActionPending) return;
    if (tokenStorageBlocked) {
      setPageError('浏览器阻止保存邀请令牌。请允许此站点使用会话存储后刷新页面，再登录以免丢失邀请。');
      return;
    }
    setAuthActionPending(true);
    setPageError('');
    setLoginMessage('');
    try {
      const returnUrl = new URL(window.location.pathname, window.location.origin).href;
      const result = authClient.session.redirectToLogin({ returnUrl });
      if (result.error) throw new Error(result.error.message || '飞书登录跳转失败。');
      setLoginMessage('正在打开飞书登录。如果页面没有跳转，请再次点击登录按钮。');
    } catch (error) {
      setPageError(errorMessage(error, '飞书登录跳转失败，请稍后重试。'));
    } finally {
      setAuthActionPending(false);
    }
  }

  async function refreshPlatformLogin() {
    if (authActionPending) return;
    if (tokenStorageBlocked) {
      setPageError('浏览器阻止保存邀请令牌。为避免丢失邀请，暂不跳转登录；请允许此站点使用会话存储后刷新页面。');
      return;
    }
    setAuthActionPending(true);
    setPageError('');
    setLoginMessage('');
    try {
      const signOut = await authClient.session.signOut();
      if (signOut.error) throw new Error(signOut.error.message || '退出当前登录状态失败。');
      const returnUrl = new URL(window.location.pathname, window.location.origin).href;
      const result = authClient.session.redirectToLogin({ returnUrl });
      if (result.error) throw new Error(result.error.message || '飞书登录跳转失败。');
      setLoginMessage('正在重新登录。登录后，请刷新邀请状态以重新核对工作区权限。');
    } catch (error) {
      setPageError(errorMessage(error, '无法刷新登录状态，请使用飞书账号重新登录后再试。'));
    } finally {
      setAuthActionPending(false);
    }
  }

  async function refreshInvitationStatus() {
    setPageError('');
    setClaimError('');
    const contextResult = await contextQuery.refetch();
    if (contextResult.error) {
      setPageError(invitationFailureMessage(contextResult.error));
      return;
    }
    const invitationResult = await inspectionQuery.refetch();
    if (invitationResult.error) setPageError(invitationFailureMessage(invitationResult.error));
  }

  function enterWorkspace() {
    const view = inspectionQuery.data;
    if (!view?.canEnter || view.localPreview) return;
    const firstBrandId = view.invitation.brands[0]?.brandId;
    if (!firstBrandId) {
      setPageError('服务端未返回可进入的品牌，请联系管理员核对邀请范围。');
      return;
    }
    removeSessionValue(INVITATION_TOKEN_KEY);
    const appPath = window.location.pathname.replace(/\/join\/?$/u, '/') || '/';
    const destination = new URL(appPath, window.location.origin);
    destination.searchParams.set('brandId', firstBrandId);
    window.location.assign(`${destination.pathname}${destination.search}`);
  }

  const context = contextQuery.data;
  const view = inspectionQuery.data;
  const authError = isAuthenticationError(contextQuery.error) || isAuthenticationError(inspectionQuery.error);
  const currentError = contextQuery.error ?? inspectionQuery.error;
  const localPreview = context?.localPreview === true || view?.localPreview === true;

  if (!token) return <main className="invitation-join-page">
    <section className="invitation-join-card" aria-labelledby="invitation-join-title">
      <span className="invitation-join-icon invitation-join-icon-error"><AlertCircle size={22} /></span>
      <h1 id="invitation-join-title">邀请链接无效</h1>
      <p>请从管理员发送的完整邀请链接打开本页，或联系管理员重新生成链接。</p>
    </section>
  </main>;

  return <main className="invitation-join-page">
    <section className="invitation-join-card" aria-labelledby="invitation-join-title">
      <span className="invitation-join-icon"><Link2 size={22} /></span>
      <p className="invitation-join-eyebrow">品牌工作区邀请</p>
      <h1 id="invitation-join-title">加入品牌工作区</h1>
      <p className="invitation-join-intro">请使用本人的飞书账号查看邀请。提交领取后，还需管理员核对并确认开通。</p>

      {tokenStorageBlocked && <div className="notice notice-warning invitation-local-preview" role="alert">
        <ShieldCheck size={15} /><span>浏览器阻止保存邀请令牌。本页暂时保留链接状态，但不能跳转登录以免丢失邀请。请允许此站点使用会话存储后刷新本页。</span>
      </div>}

      {localPreview && <div className="notice notice-warning invitation-local-preview" role="status">
        <ShieldCheck size={15} /><span>本机模拟账号，不代表飞书登录。此环境仅用于检查邀请流程。</span>
      </div>}

      {contextQuery.isLoading && <div className="invitation-join-state" role="status"><LoaderCircle className="spin" size={19} />正在核对当前登录账号…</div>}
      {authError && <div className="invitation-join-state invitation-join-error" role="alert">
        <AlertCircle size={18} /><p>{invitationFailureMessage(currentError)}</p>
        <Button onClick={() => void handleLogin()} disabled={authActionPending || tokenStorageBlocked}>{authActionPending ? '正在跳转…' : '使用飞书账号登录'}</Button>
      </div>}
      {contextQuery.isError && !authError && <div className="invitation-join-state invitation-join-error" role="alert">
        <AlertCircle size={18} /><p>{invitationFailureMessage(contextQuery.error)}</p>
        <Button variant="outline" onClick={() => void contextQuery.refetch()} disabled={contextQuery.isFetching}>重试读取账号</Button>
      </div>}
      {contextQuery.isSuccess && inspectionQuery.isLoading && <div className="invitation-join-state" role="status"><LoaderCircle className="spin" size={19} />正在读取邀请状态…</div>}
      {contextQuery.isSuccess && inspectionQuery.isError && !isAuthenticationError(inspectionQuery.error) && <div className="invitation-join-state invitation-join-error" role="alert">
        <AlertCircle size={18} /><p>{invitationFailureMessage(inspectionQuery.error)}</p>
        <Button variant="outline" onClick={() => void refreshInvitationStatus()} disabled={inspectionQuery.isFetching || contextQuery.isFetching}>刷新状态</Button>
      </div>}

      {contextQuery.isSuccess && inspectionQuery.isSuccess && view && <>
        <div className="invitation-join-state invitation-join-status" role="status">
          {view.invitation.status === 'completed' && view.canEnter
            ? <CheckCircle2 size={19} />
            : view.invitation.status === 'expired' || view.invitation.status === 'revoked'
              ? <AlertCircle size={19} /> : <Clock3 size={19} />}
          <div><strong>{invitationStatusLabel(view.invitation.status)}</strong><p>{friendlyStatusDescription(view.invitation.status, view.claimedByYou, view.message)}</p></div>
        </div>

        <dl className="invitation-join-details">
          <div><dt>邀请对象</dt><dd>{view.invitation.recipientName}</dd></div>
          <div><dt>当前账号</dt><dd className="invitation-join-account"><UserRound size={15} />{view.displayName || context?.displayName || '当前飞书账号'}</dd></div>
          <div><dt>岗位</dt><dd>{INVITATION_ROLE_LABELS[view.invitation.role]}</dd></div>
          <div><dt>品牌范围</dt><dd className="invitation-join-brands">{view.invitation.brands.map((brand) => <span className="invitation-brand-chip" key={brand.brandId}>
            {brand.brandName}{view.invitation.role === 'bd' && brand.businessOwnerName ? ` · ${brand.businessOwnerName}` : ''}
          </span>)}</dd></div>
          <div><dt>有效期至</dt><dd>{new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(view.invitation.expiresAt))}</dd></div>
        </dl>

        {claimError && <div className="notice notice-error invitation-join-notice" role="alert">{claimError}</div>}
        {pageError && <div className="notice notice-error invitation-join-notice" role="alert">{pageError}</div>}
        {loginMessage && <div className="notice notice-info invitation-join-notice" role="status">{loginMessage}</div>}

        <div className="invitation-join-actions">
          {view.invitation.status === 'pending' && !view.claimedByYou && view.canClaim && <Button onClick={() => { setClaimError(''); claimMutation.mutate(); }} disabled={claimMutation.isPending}>
            {claimMutation.isPending ? '提交中…' : '确认领取邀请'}
          </Button>}
          {view.invitation.status === 'completed' && view.canEnter && !localPreview && <Button onClick={enterWorkspace}>进入工作区</Button>}
          {view.invitation.status === 'completed' && !view.canEnter && !localPreview && <Button variant="outline" onClick={() => void refreshPlatformLogin()} disabled={authActionPending || tokenStorageBlocked}>
            {authActionPending ? '正在跳转…' : '重新登录并刷新权限'}
          </Button>}
          <Button type="button" variant="outline" onClick={() => void refreshInvitationStatus()} disabled={contextQuery.isFetching || inspectionQuery.isFetching || claimMutation.isPending}>
            <RefreshCw size={14} />刷新状态
          </Button>
        </div>
      </>}
    </section>
  </main>;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}
