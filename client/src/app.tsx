import { PLATFORM_INTEGRATIONS_ENABLED } from './lib/public-config';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DomainCommand } from '@shared/commands';
import type { LocalRoleSelection, SessionResponse } from '@shared/http';
import { ApiError, executeCommand, getActiveBusinessBrandId, getSession, getWorkspace, switchDemoProfile, switchLocalRole } from './api';
import { WorkbenchContext, type WorkbenchContextValue } from './workbench-context';
import Layout from './components/Layout';
import { FullPageError, FullPageLoading } from './components/workbench';
import TodayPage from './pages/TodayPage';
import BusinessHome from './pages/BusinessHome';
import CreatorsPage from './pages/CreatorsPage';
import SamplesPage from './pages/SamplesPage';
import CooperationsPage from './pages/CooperationsPage';
import SchedulePage from './pages/SchedulePage';
import OrdersPage from './pages/OrdersPage';
import DashboardPage from './pages/DashboardPage';
import TeamPage from './pages/TeamPage';
const TeamPerformancePage = lazy(() => import('./pages/TeamPerformancePage'));
import CatalogPage from './pages/CatalogPage';
import AuditPage from './pages/AuditPage';
import ProductsPage from './pages/ProductsPage';
import GuidePage from './pages/GuidePage';
import RulesPage from './pages/RulesPage';
import StoresPage from './pages/StoresPage';
import AssortmentsPage from './pages/AssortmentsPage';
import ProposalsPage from './pages/ProposalsPage';
import PartnersPage from './pages/PartnersPage';
import ContentPage from './pages/ContentPage';
import ExpensesPage from './pages/ExpensesPage';
import TargetsPage from './pages/TargetsPage';
import LocalWorkbookHome, { LocalWorkbookUnavailable } from './pages/LocalWorkbookHome';
import LocalDataScreen from './pages/LocalDataScreen';
import WorkbookPage from './pages/WorkbookPage';
const BrandsPage = lazy(() => import('./pages/BrandsPage'));
const InvitationJoinPage = lazy(() => import('./pages/InvitationJoinPage'));
import { isSourceScenarioWorkspace, isUnavailableDemoBrand } from '@shared/scenario-brand';
import { canPreviewLocalRole, getWorkbookContext, isBusinessWorkspace, isWorkbook } from './lib/workbook-context';
import './app.css';

const LOCAL_ROLE_CHANNEL = 'dabo-local-role-sync';
type LocalRoleSyncMessage = { type: 'local-role-changed'; nonce: string };

function isLocalRoleSyncMessage(value: unknown): value is LocalRoleSyncMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<LocalRoleSyncMessage>;
  return message.type === 'local-role-changed' && typeof message.nonce === 'string' && message.nonce.length > 0 && message.nonce.length < 100;
}

function localRoleScopeKey(session: SessionResponse | undefined) {
  if (!session) return '';
  const capabilities = [...session.actor.capabilities].sort().join(',');
  return `${session.dataMode}:${session.actor.principalId}:${session.actor.role}:${capabilities}:${session.localWorkbook?.role ?? ''}:${session.localWorkbook?.businessOwnerName ?? ''}`;
}

async function clearLocalScopeQueries(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: ['workspace'] }),
    queryClient.cancelQueries({ queryKey: ['local-workbook'] }),
    queryClient.cancelQueries({ queryKey: ['local-workbook-summary'] }),
    queryClient.cancelQueries({ queryKey: ['workbook'] }),
  ]);
  queryClient.removeQueries({ queryKey: ['workspace'] });
  queryClient.removeQueries({ queryKey: ['local-workbook'] });
  queryClient.removeQueries({ queryKey: ['local-workbook-summary'] });
  queryClient.removeQueries({ queryKey: ['workbook'] });
}

function makeLocalRoleNonce() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function WorkbenchRuntime() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [authExpired, setAuthExpired] = useState<ApiError | null>(null);
  const [localSessionRefreshing, setLocalSessionRefreshing] = useState(false);
  const localSessionRefreshingRef = useRef(false);
  const localFocusRefreshRef = useRef(false);
  const localRefreshGenerationRef = useRef(0);
  const pendingLocalRoleSyncRef = useRef(false);
  const localRoleRefreshCallbackRef = useRef<(() => void) | null>(null);
  const localRoleChannelRef = useRef<BroadcastChannel | null>(null);
  const ownLocalRoleNonceRef = useRef('');
  const requestedBrandId = new URLSearchParams(location.search).get('brandId') ?? getActiveBusinessBrandId();
  const sessionQueryKey = useMemo(() => requestedBrandId ? ['session', requestedBrandId] as const : ['session'] as const, [requestedBrandId]);
  useEffect(() => {
    const handleAuthExpired = (event: Event) => {
      const detail = (event as CustomEvent<{ loginUrl?: string }>).detail;
      setAuthExpired(new ApiError({ code: 'UNAUTHENTICATED', message: '登录状态已失效，请重新登录后继续。', loginUrl: detail?.loginUrl }));
      void queryClient.cancelQueries({ queryKey: ['workspace'] }).then(() => queryClient.removeQueries({ queryKey: ['workspace'] }));
      queryClient.removeQueries({ queryKey: ['session'] });
    };
    window.addEventListener('dabo:unauthenticated', handleAuthExpired);
    return () => window.removeEventListener('dabo:unauthenticated', handleAuthExpired);
  }, [queryClient]);
  const sessionQuery = useQuery({
    queryKey: sessionQueryKey,
    queryFn: async () => {
      const session = await getSession(requestedBrandId);
      const selectedBrand = session.businessWorkspace?.brandId ?? session.workbook?.brandId;
      if (selectedBrand) queryClient.setQueryData(['session', selectedBrand], session);
      return session;
    },
    retry: false,
    staleTime: 30_000,
  });
  const localMode = canPreviewLocalRole(sessionQuery.data);
  useEffect(() => {
    const current = sessionQuery.data?.businessWorkspace;
    if (!current) return;
    const params = new URLSearchParams(location.search);
    const requestedBrandId = params.get('brandId');
    if (requestedBrandId === current.brandId) return;
    const requestedBrand = (sessionQuery.data?.brands ?? []).find((brand) => brand.id === requestedBrandId);
    if (requestedBrand && !isUnavailableDemoBrand(requestedBrand)) return;
    params.set('brandId', current.brandId);
    navigate(`${location.pathname}?${params}`, { replace: true });
  }, [sessionQuery.data?.businessWorkspace?.brandId, sessionQuery.data?.brands, location.pathname, location.search, navigate]);
  useEffect(() => {
    if (!localMode) return;
    let lastResumeAt = 0;

    const refreshLocalSession = async (clearImmediately: boolean) => {
      const previousSession = queryClient.getQueryData<SessionResponse>(sessionQueryKey);
      if (clearImmediately) {
        if (localSessionRefreshingRef.current) {
          pendingLocalRoleSyncRef.current = true;
          return;
        }
        localSessionRefreshingRef.current = true;
        setLocalSessionRefreshing(true);
        const generation = ++localRefreshGenerationRef.current;
        try {
          await clearLocalScopeQueries(queryClient);
          await queryClient.cancelQueries({ queryKey: sessionQueryKey });
          queryClient.removeQueries({ queryKey: sessionQueryKey });
          const freshSession = await queryClient.fetchQuery({
            queryKey: sessionQueryKey,
            queryFn: () => getSession(requestedBrandId),
            retry: false,
            staleTime: 0,
          });
          if (generation === localRefreshGenerationRef.current) queryClient.setQueryData(sessionQueryKey, freshSession);
        } catch {
          // Let the session query surface a safe error state; never restore old role-scoped rows here.
          if (generation === localRefreshGenerationRef.current) queryClient.removeQueries({ queryKey: sessionQueryKey });
        } finally {
          if (generation === localRefreshGenerationRef.current) {
            localSessionRefreshingRef.current = false;
            setLocalSessionRefreshing(false);
          }
          if (pendingLocalRoleSyncRef.current) {
            pendingLocalRoleSyncRef.current = false;
            localRoleRefreshCallbackRef.current?.();
          }
        }
        return;
      }

      // A resume check is deliberately background-only: if the role is unchanged it must not
      // unmount the provider, which would discard an in-progress form.
      if (localSessionRefreshingRef.current || localFocusRefreshRef.current) return;
      localFocusRefreshRef.current = true;
      const generation = localRefreshGenerationRef.current;
      try {
        const freshSession = await getSession(requestedBrandId);
        if (generation !== localRefreshGenerationRef.current || localSessionRefreshingRef.current) return;
        if (localRoleScopeKey(previousSession) !== localRoleScopeKey(freshSession)) {
          localSessionRefreshingRef.current = true;
          setLocalSessionRefreshing(true);
          const scopeGeneration = ++localRefreshGenerationRef.current;
          try {
            await clearLocalScopeQueries(queryClient);
            if (scopeGeneration === localRefreshGenerationRef.current) queryClient.setQueryData(sessionQueryKey, freshSession);
          } finally {
            if (scopeGeneration === localRefreshGenerationRef.current) {
              localSessionRefreshingRef.current = false;
              setLocalSessionRefreshing(false);
            }
            if (pendingLocalRoleSyncRef.current) {
              pendingLocalRoleSyncRef.current = false;
              localRoleRefreshCallbackRef.current?.();
            }
          }
        } else {
          queryClient.setQueryData(sessionQueryKey, freshSession);
        }
      } catch {
        // A failed background check leaves the current workspace mounted; auth failures still
        // dispatch the existing unauthenticated event from the API client.
      } finally {
        localFocusRefreshRef.current = false;
      }
    };
    localRoleRefreshCallbackRef.current = () => { void refreshLocalSession(true); };

    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(LOCAL_ROLE_CHANNEL);
    localRoleChannelRef.current = channel;
    if (channel) {
      channel.onmessage = (event: MessageEvent<unknown>) => {
        if (!isLocalRoleSyncMessage(event.data) || event.data.nonce === ownLocalRoleNonceRef.current) return;
        void refreshLocalSession(true);
      };
    }
    const refreshOnResume = () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastResumeAt < 1200) return;
      lastResumeAt = Date.now();
      void refreshLocalSession(false);
    };
    window.addEventListener('focus', refreshOnResume);
    document.addEventListener('visibilitychange', refreshOnResume);
    return () => {
      window.removeEventListener('focus', refreshOnResume);
      document.removeEventListener('visibilitychange', refreshOnResume);
      channel?.close();
      if (localRoleChannelRef.current === channel) localRoleChannelRef.current = null;
      localRoleRefreshCallbackRef.current = null;
    };
  }, [localMode, queryClient, sessionQueryKey, requestedBrandId]);
  const dataMode = sessionQuery.data?.dataMode ?? 'unknown';
  const workbook = getWorkbookContext(sessionQuery.data);
  const workbookMode = isWorkbook(sessionQuery.data);
  const businessMode = isBusinessWorkspace(sessionQuery.data);
  const brandId = sessionQuery.data?.businessWorkspace?.brandId ?? workbook?.brandId ?? undefined;
  const principalId = sessionQuery.data?.actor.principalId ?? 'anonymous';
  const actorRole = sessionQuery.data?.actor.role ?? 'unknown';
  const capabilityKey = [...(sessionQuery.data?.actor.capabilities ?? [])].sort().join(',');
  const localRole = workbook?.role ?? '';
  const localBusinessOwner = workbook?.businessOwnerName ?? '';
  const workspaceQueryKey = ['workspace', dataMode, principalId, actorRole, capabilityKey, localRole, localBusinessOwner, brandId ?? 'no-brand'] as const;
  const shouldLoadWorkspace = Boolean(sessionQuery.data && (sessionQuery.data.dataMode !== 'production' || workbookMode || businessMode));
  const workspaceQuery = useQuery({
    queryKey: workspaceQueryKey,
    queryFn: () => getWorkspace({}, brandId),
    enabled: shouldLoadWorkspace,
    staleTime: 10_000,
  });
  const commandMutation = useMutation({
    mutationFn: (command: DomainCommand) => executeCommand(command, brandId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['workspace'] });
    },
  });
  const profileMutation = useMutation({
    mutationFn: switchDemoProfile,
    onSuccess: async (session) => {
      await queryClient.cancelQueries({ queryKey: ['workspace'] });
      queryClient.removeQueries({ queryKey: ['workspace'] });
      queryClient.setQueryData(sessionQueryKey, session);
    },
  });
  const localRoleMutation = useMutation({
    mutationFn: switchLocalRole,
    onSuccess: async (session) => {
      const generation = ++localRefreshGenerationRef.current;
      localSessionRefreshingRef.current = true;
      setLocalSessionRefreshing(true);
      try {
        await clearLocalScopeQueries(queryClient);
        queryClient.setQueryData(sessionQueryKey, session);
        const selectedBrand = session.businessWorkspace?.brandId ?? session.workbook?.brandId;
        if (selectedBrand) queryClient.setQueryData(['session', selectedBrand], session);
        navigate(selectedBrand ? `/?brandId=${encodeURIComponent(selectedBrand)}` : '/');
        const nonce = makeLocalRoleNonce();
        ownLocalRoleNonceRef.current = nonce;
        localRoleChannelRef.current?.postMessage({ type: 'local-role-changed', nonce } satisfies LocalRoleSyncMessage);
      } finally {
        if (generation === localRefreshGenerationRef.current) {
          localSessionRefreshingRef.current = false;
          setLocalSessionRefreshing(false);
        }
        if (pendingLocalRoleSyncRef.current) {
          pendingLocalRoleSyncRef.current = false;
          localRoleRefreshCallbackRef.current?.();
        }
      }
    },
  });

  const context = useMemo(() => {
    if (!sessionQuery.data || !workspaceQuery.data) return null;
    return {
      session: sessionQuery.data,
      workspace: workspaceQuery.data,
      running: commandMutation.isPending || profileMutation.isPending || localRoleMutation.isPending,
      run: (command: DomainCommand) => commandMutation.mutateAsync(command),
      changeDemoProfile: async (principalId: string) => {
        if (sessionQuery.data.dataMode !== 'demo') throw new ApiError({ code: 'FORBIDDEN', message: '生产环境不能切换演示身份。' });
        if (!sessionQuery.data.allowedDemoProfiles.some((profile) => profile.principalId === principalId)) {
          throw new ApiError({ code: 'FORBIDDEN', message: '该演示身份不在服务端允许的范围内。' });
        }
        await profileMutation.mutateAsync(principalId);
      },
      changeLocalRole: async (selection: LocalRoleSelection) => {
        if (!canPreviewLocalRole(sessionQuery.data)) {
          throw new ApiError({ code: 'FORBIDDEN', message: '当前工作区不支持本机岗位预览。' });
        }
        await localRoleMutation.mutateAsync(selection);
      },
      refresh: async () => {
        await queryClient.invalidateQueries({ queryKey: ['workspace'] });
      },
    } satisfies WorkbenchContextValue;
  }, [sessionQuery.data, workspaceQuery.data, commandMutation.isPending, profileMutation.isPending, localRoleMutation.isPending, commandMutation.mutateAsync, profileMutation.mutateAsync, localRoleMutation.mutateAsync, queryClient]);

  const scenarioWorkspace = isSourceScenarioWorkspace(workspaceQuery.data?.scenarioInfo);
  const replacementBrandId = (sessionQuery.data?.brands ?? []).find((brand) => brand.active && !isUnavailableDemoBrand(brand))?.id;
  useEffect(() => {
    if (!scenarioWorkspace || !replacementBrandId) return;
    const params = new URLSearchParams(location.search);
    if (params.get('brandId') === replacementBrandId) return;
    params.set('brandId', replacementBrandId);
    navigate(`${location.pathname}?${params}`, { replace: true });
  }, [scenarioWorkspace, replacementBrandId, location.pathname, location.search, navigate]);

  if (authExpired) return <FullPageError error={authExpired} retry={async () => { setAuthExpired(null); await sessionQuery.refetch(); }} />;
  if (localSessionRefreshing) return <FullPageLoading label="正在切换角色" />;
  if (sessionQuery.isLoading || (shouldLoadWorkspace && workspaceQuery.isLoading)) return <FullPageLoading label="正在连接工作台" />;
  if (scenarioWorkspace && replacementBrandId && new URLSearchParams(location.search).get('brandId') !== replacementBrandId) return <FullPageLoading label="正在打开工作区" />;
  if (sessionQuery.error) return <FullPageError error={sessionQuery.error} retry={() => sessionQuery.refetch()} />;
  if (sessionQuery.data?.dataMode === 'production' && sessionQuery.data.workbook?.storage === 'cloud' && !workbookMode && !businessMode) return <BrandsPage session={sessionQuery.data} />;
  if (shouldLoadWorkspace && workspaceQuery.error) return <FullPageError error={workspaceQuery.error} retry={() => workspaceQuery.refetch()} />;
  if (!context) return <FullPageError error={new Error('数据加载失败，请重试。')} retry={() => workspaceQuery.refetch()} />;

  return (
      <WorkbenchContext.Provider key={`${sessionQuery.data?.dataMode}:${sessionQuery.data?.actor.principalId}:${localRole}:${localBusinessOwner}:${brandId ?? ''}`} value={context}>
      <Routes>
        <Route element={<Layout />}>
          {workbookMode ? <>
            <Route index element={<LocalWorkbookHome />} />
            <Route path="guide" element={<LocalWorkbookHome guide />} />
            <Route path="data-screen" element={workbook?.role === 'local_manager' ? <LocalDataScreen /> : <LocalWorkbookUnavailable />} />
            <Route path="samples" element={<WorkbookPage kind="samples" />} />
            <Route path="schedule" element={<WorkbookPage kind="broadcast" />} />
            <Route path="brands" element={<BrandsPage session={sessionQuery.data!} />} />
            <Route path="*" element={<LocalWorkbookUnavailable />} />
          </> : <>
            <Route index element={businessMode ? <BusinessHome /> : <TodayPage />} />
            <Route path="guide" element={<GuidePage />} />
            <Route path="tasks" element={<TodayPage tasksOnly />} />
            <Route path="creators" element={<CreatorsPage />} />
            <Route path="public-pool" element={<CreatorsPage publicPool />} />
            <Route path="samples" element={<SamplesPage />} />
            <Route path="cooperations" element={<CooperationsPage />} />
            <Route path="schedule" element={<SchedulePage />} />
            <Route path="orders" element={<OrdersPage />} />
            <Route path="dashboard" element={businessMode ? <TeamPerformancePage /> : <DashboardPage />} />
            <Route path="team" element={businessMode ? <TeamPerformancePage /> : <TeamPage />} />
            <Route path="products" element={businessMode ? <CatalogPage /> : <ProductsPage />} />
            <Route path="rules" element={<RulesPage />} />
            <Route path="audit" element={<AuditPage />} />
            <Route path="stores" element={<StoresPage />} />
            <Route path="assortments" element={businessMode ? <CatalogPage /> : <AssortmentsPage />} />
            <Route path="proposals" element={<ProposalsPage />} />
            <Route path="partners" element={<PartnersPage />} />
            <Route path="content" element={<ContentPage />} />
            <Route path="expenses" element={<ExpensesPage />} />
            <Route path="targets" element={<TargetsPage />} />
            {businessMode && <>
              <Route path="brands" element={<BrandsPage session={sessionQuery.data!} />} />
              <Route path="source-records" element={<LocalWorkbookHome guide />} />
              <Route path="source-records/samples" element={<WorkbookPage kind="samples" />} />
              <Route path="source-records/broadcast" element={<WorkbookPage kind="broadcast" />} />
              <Route path="source-records/data-screen" element={workbook?.role === 'local_manager' ? <LocalDataScreen /> : <LocalWorkbookUnavailable />} />
              <Route path="data-screen" element={<Navigate replace to={`/source-records/data-screen${location.search}`} />} />
            </>}
            <Route path="*" element={<FullPageError error={new Error('没有找到这个页面。')} />} />
          </>}
        </Route>
      </Routes>
    </WorkbenchContext.Provider>
  );
}

export default function WorkbenchApp() {
  const location = useLocation();
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 }, mutations: { retry: false } },
  }));
  if (location.pathname === '/read') return <Navigate to="/" replace />;
  return <QueryClientProvider client={queryClient}><Suspense fallback={<FullPageLoading label="正在加载工作台" />}><Routes>
    <Route path="/join" element={PLATFORM_INTEGRATIONS_ENABLED ? <InvitationJoinPage /> : <FullPageError error={new Error("此离线演示未启用平台邀请，请使用工作台角色预览。 ")} />} />
    <Route path="*" element={<WorkbenchRuntime />} />
  </Routes></Suspense></QueryClientProvider>;
}
