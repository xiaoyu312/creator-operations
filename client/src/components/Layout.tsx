import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ChartNoAxesCombined, ClipboardList, FileText, LayoutGrid, Menu, MoreHorizontal, Package, Radio, Search, UsersRound, X } from 'lucide-react';
import { getActiveNavigationModule, getActiveNavigationRoute, getBusinessNavigationModules, getLocalNavigationModules, getNavigationModules } from '../lib/navigation';
import { getWorkbookSummary } from '../lib/workbook-api';
import { getWorkbookContext, workbookSummaryQueryKey } from '../lib/workbook-context';
import { useWorkbench } from '../workbench-context';
import LocalPlatformTabs from './LocalPlatformTabs';
import { WalkthroughProvider } from '../walkthrough-context';
import { Button } from './ui/button';
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from './ui/sheet';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { WalkthroughDock } from './Walkthrough';
import LocalRoleSwitcher from './LocalRoleSwitcher';
import BrandSwitcher from './BrandSwitcher';
import { ProductMark } from './ProductVisuals';
import { PRODUCT_NAME } from '../lib/visual-assets';
import { GuideLauncherButton, OnboardingGuideProvider } from './OnboardingGuide';
import '../navigation.css';
import '../reference-theme.css';
import '../experience-refresh.css';

function roleLabel(role: string) {
  return ({ admin: '管理员', manager: '团队主管', bd: '达人商务', ops: '样品运营' } as Record<string, string>)[role] ?? role;
}

function localRoleLabel(role: string | undefined) {
  return ({ local_manager: '管理岗', local_bd: '商务', local_shipping: '发货', local_links: '链接' } as Record<string, string>)[role ?? ''] ?? '本机岗位';
}

function withBrandRoute(modules: ReturnType<typeof getLocalNavigationModules>, canManageBrands: boolean) {
  if (!canManageBrands) return modules;
  return modules.map((item) => item.id === 'work' ? {
    ...item,
    routes: [...item.routes, { id: 'brands', label: '品牌管理', to: '/brands', pathname: '/brands' }],
  } : item);
}

function NavigationIcon({ routeId }: { routeId: string }) {
  const Icon = routeId.includes('data-screen') || routeId === 'dashboard' ? ChartNoAxesCombined
    : routeId.includes('sample') ? Package
      : routeId.includes('broadcast') || routeId === 'schedule' ? Radio
        : routeId.includes('creator') || routeId === 'team' ? UsersRound
          : routeId.includes('guide') || routeId === 'rules' ? FileText
            : routeId.includes('unknown') || routeId === 'tasks' || routeId === 'audit' ? ClipboardList
              : LayoutGrid;
  return <Icon size={16} strokeWidth={1.7} aria-hidden="true" />;
}

function workspaceLabel(role: string) {
  if (role === 'bd') return '商务工作区';
  if (role === 'ops') return '运营工作区';
  return '团队管理区';
}

function localNavigationHref(to: string, search: string, preservePlatform = true) {
  const target = new URL(to, 'https://local-navigation.invalid');
  const params = new URLSearchParams(target.search);
  const current = new URLSearchParams(search);
  const brandId = current.get('brandId');
  if (brandId && !params.has('brandId')) params.set('brandId', brandId);
  for (const key of preservePlatform ? ['platform', 'year'] : ['year']) {
    const value = current.get(key);
    if (value && !params.has(key)) params.set(key, value);
  }
  const query = params.toString();
  return `${target.pathname}${query ? `?${query}` : ''}`;
}

function DemoSwitch() {
  const { session, changeDemoProfile } = useWorkbench();
  const [error, setError] = useState('');
  if (session.dataMode !== 'demo') return null;
  const selected = session.allowedDemoProfiles.find((profile) => profile.principalId === session.actor.principalId)?.principalId ?? '';
  const names = { admin: '管理员', manager: '主管', bd: '商务', ops: '运营' } as Record<string, string>;
  const handleChange = async (principalId: string) => {
    if (!principalId || principalId === selected) return;
    setError('');
    try { await changeDemoProfile(principalId); } catch (cause) { setError(cause instanceof Error ? cause.message : '切换失败'); }
  };
  return (
    <div className="demo-banner navigation-demo-banner" role="status">
      <span className="demo-pill">DEMO</span>
      <span className="demo-banner-copy">示例数据</span>
      <label className="demo-profile-label" htmlFor="demo-profile">身份</label>
      <select id="demo-profile" value={selected} onChange={(event) => void handleChange(event.target.value)} aria-label="切换演示身份">
        {session.allowedDemoProfiles.map((profile) => <option key={profile.principalId} value={profile.principalId}>{profile.displayName} · {names[profile.role] ?? profile.role}</option>)}
      </select>
      {error && <span className="demo-error">{error}</span>}
    </div>
  );
}

function MobileModuleMenu({
  modules,
  module,
  activeRouteId,
  localScopeRoutes = [],
  localMode,
  open,
  onOpenChange,
}: {
  modules: ReturnType<typeof getNavigationModules>;
  module: ReturnType<typeof getNavigationModules>[number];
  activeRouteId?: string;
  localScopeRoutes?: ReturnType<typeof getNavigationModules>[number]['routes'];
  localMode: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const location = useLocation();
  const contextRoutes = module.id === 'work'
    ? module.routes.filter((item) => item.id !== 'local-home' && item.id !== 'local-unknown')
    : module.routes;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild><Button variant="outline" size="sm" className="mobile-module-trigger" aria-label="打开业务导航"><Menu size={16} /><span>菜单</span></Button></SheetTrigger>
      <SheetContent side="left" className="navigation-mobile-sheet">
        <div className="mobile-module-sheet-header">
          <div><span>当前：{module.label}</span><SheetTitle>业务导航</SheetTitle></div>
          <SheetClose asChild><Button variant="ghost" size="icon" className="mobile-module-close" aria-label="关闭菜单"><X size={18} /></Button></SheetClose>
        </div>
        <div className="mobile-navigation-scroll">
          <section className="mobile-module-overview" aria-labelledby="mobile-all-modules-title">
            <h3 id="mobile-all-modules-title">全部模块</h3>
            <nav className="mobile-all-modules" aria-label="全部业务模块">
              {modules.map((item) => <Link key={item.id}
                to={localMode ? localNavigationHref(item.to, location.search) : item.to}
                onClick={() => onOpenChange(false)}
                className={`mobile-all-module-link${item.id === module.id ? ' is-active' : ''}`}
                aria-current={item.id === module.id ? 'page' : undefined}>
                <NavigationIcon routeId={item.routes[0]?.id ?? item.id} /><span>{item.label}</span>
              </Link>)}
            </nav>
          </section>
          <h3 className="mobile-current-module-heading">{module.label}子页面</h3>
        <nav className="mobile-module-links" aria-label={`${module.label}子页面`}>
          {localScopeRoutes.map((item) => <Link key={item.id} to={localNavigationHref(item.to, location.search, false)} onClick={() => onOpenChange(false)} className={`context-nav-link${item.id === activeRouteId ? ' is-active' : ''}`} aria-current={item.id === activeRouteId ? 'page' : undefined}>
            <span>{item.label}</span>{item.badge ? <span className="context-nav-badge">{item.badge.toLocaleString('zh-CN')}</span> : <span className="context-nav-arrow" aria-hidden="true">›</span>}
          </Link>)}
          {contextRoutes.map((item) => <Link key={item.id} to={localMode ? localNavigationHref(item.to, location.search) : item.to} onClick={() => onOpenChange(false)} className={`context-nav-link${item.id === activeRouteId ? ' is-active' : ''}`} aria-current={item.id === activeRouteId ? 'page' : undefined}>
            <span>{item.label}</span>{item.badge ? <span className="context-nav-badge">{item.badge.toLocaleString('zh-CN')}</span> : <span className="context-nav-arrow" aria-hidden="true">›</span>}
          </Link>)}
        </nav>
        </div>
        <p className="mobile-module-hint">按 Esc 或点右上角可关闭</p>
      </SheetContent>
    </Sheet>
  );
}

function TopBar({
  modules,
  activeModule,
  activeRouteId,
}: {
  modules: ReturnType<typeof getNavigationModules>;
  activeModule: ReturnType<typeof getNavigationModules>[number];
  activeRouteId?: string;
}) {
  const { session } = useWorkbench();
  const business = session.businessWorkspace;
  const workbook = business ? null : getWorkbookContext(session);
  const brandScoped = Boolean(business || workbook?.brandId);
  const location = useLocation();
  const navigate = useNavigate();
  const [search, setSearch] = useState(() => {
    const isCreatorSearchRoute = location.pathname === '/creators' || location.pathname === '/public-pool';
    return isCreatorSearchRoute ? new URLSearchParams(location.search).get('q') ?? '' : '';
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const canSearchCreators = !workbook && session.actor.role !== 'ops';
  const localScopeRoutes = workbook
    ? modules.find((item) => item.id === 'work')?.routes.filter((item) => item.id === 'local-home' || item.id === 'local-unknown') ?? []
    : [];
  useEffect(() => {
    const isCreatorSearchRoute = location.pathname === '/creators' || location.pathname === '/public-pool';
    setSearch(isCreatorSearchRoute ? new URLSearchParams(location.search).get('q') ?? '' : '');
  }, [location.pathname, location.search]);
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && searchRef.current) {
        event.preventDefault(); searchRef.current.focus();
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);
  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    navigate(localNavigationHref(`/creators${search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ''}`, location.search));
  };

  return (
    <header className="navigation-topbar">
      <Link to={brandScoped ? localNavigationHref('/', location.search) : '/'} className="brand-lockup navigation-brand" aria-label={`${PRODUCT_NAME}首页`}>
        <span className="brand-mark product-brand-mark"><ProductMark /></span>
        <span><strong>{PRODUCT_NAME}</strong><small>达人合作管理</small></span>
      </Link>
      <MobileModuleMenu modules={modules} module={activeModule} activeRouteId={activeRouteId} localScopeRoutes={localScopeRoutes} localMode={Boolean(workbook) || brandScoped} open={mobileOpen} onOpenChange={setMobileOpen} />
      <nav className="top-module-nav" aria-label="业务模块">
        {modules.map((item) => <Link key={item.id} to={workbook || brandScoped ? localNavigationHref(item.to, location.search) : item.to} className={`top-module-link${item.id === activeModule.id ? ' is-active' : ''}`} aria-current={item.id === activeModule.id ? 'page' : undefined}>{item.label}</Link>)}
      </nav>
      <div className="navigation-topbar-actions">
        {business && activeModule.id === 'work' && <>
          <Link className="topbar-text-link" to={localNavigationHref('/tasks', location.search)}>跟进任务</Link>
          <Link className="topbar-text-link" to={localNavigationHref('/guide', location.search)}>入门指南</Link>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="work-more-trigger" aria-label="历史资料">历史资料</Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">{activeModule.routes.filter((item) => item.id.startsWith('source-')).map((item) =>
              <DropdownMenuItem key={item.id} asChild><Link to={localNavigationHref(item.to, location.search)}>{item.label}{item.badge ? ` ${item.badge.toLocaleString('zh-CN')}` : ''}</Link></DropdownMenuItem>,
            )}</DropdownMenuContent>
          </DropdownMenu>
        </>}
        {business && <GuideLauncherButton />}
        {canSearchCreators && <form className="global-search" onSubmit={submitSearch} role="search">
          <Search size={15} aria-hidden="true" />
          <input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索达人或平台账号" aria-label="搜索达人或平台账号" />
          <kbd>⌘ K</kbd>
        </form>}
        <BrandSwitcher />
        <LocalRoleSwitcher />
        <span className="topbar-avatar" title={`${session.actor.displayName} · ${workbook ? localRoleLabel(workbook.role) : roleLabel(session.actor.role)}`}>{session.actor.displayName.slice(0, 1)}</span>
      </div>
    </header>
  );
}

function Sidebar({ module, activeRouteId, localScopeRoutes = [] }: {
  module: ReturnType<typeof getNavigationModules>[number];
  activeRouteId?: string;
  localScopeRoutes?: ReturnType<typeof getNavigationModules>[number]['routes'];
}) {
  const { session } = useWorkbench();
  const business = session.businessWorkspace;
  const workbook = business ? null : getWorkbookContext(session);
  const location = useLocation();
  const workbookMode = Boolean(workbook);
  const contextRoutes = workbookMode && module.id === 'work'
    ? module.routes.filter((item) => item.id !== 'local-home' && item.id !== 'local-unknown')
    : module.routes;
  return (
    <aside className="sidebar navigation-sidebar">
      <div className="sidebar-workspace">
        <span className="workspace-mark">{business ? business.brandName.slice(0, 2) : workbookMode ? workbook?.brandName.slice(0, 2) : session.actor.displayName.slice(0, 1)}</span>
        <span className="workspace-copy"><strong>{business?.brandName ?? (workbookMode ? workbook?.brandName : workspaceLabel(session.actor.role))}</strong><small>{business || workbookMode ? '品牌工作区' : workspaceLabel(session.actor.role)}</small></span>
      </div>
      {workbookMode && localScopeRoutes.length > 0 && <nav className="sidebar-nav context-nav local-scope-nav" aria-label="工作簿记录范围">
        {localScopeRoutes.map((item) => <Link key={item.id} to={localNavigationHref(item.to, location.search, false)} className={`context-nav-link${item.id === activeRouteId ? ' is-active' : ''}`} aria-current={item.id === activeRouteId ? 'page' : undefined}>
          <span className="context-nav-label"><NavigationIcon routeId={item.id} />{item.label}</span>{item.badge ? <span className="context-nav-badge">{item.badge.toLocaleString('zh-CN')}</span> : <span className="context-nav-arrow" aria-hidden="true">›</span>}
        </Link>)}
      </nav>}
      <div className="module-context-heading"><span>{workbookMode ? '品牌业务区' : '当前模块'}</span><strong>{module.label}</strong></div>
      <nav className="sidebar-nav context-nav" aria-label={`${module.label}子页面`}>
        {contextRoutes.map((item) => <Link key={item.id} to={workbookMode || business ? localNavigationHref(item.to, location.search) : item.to} className={`context-nav-link${item.id === activeRouteId ? ' is-active' : ''}`} aria-current={item.id === activeRouteId ? 'page' : undefined}>
          <span className="context-nav-label"><NavigationIcon routeId={item.id} />{item.label}</span>{item.badge ? <span className="context-nav-badge">{item.badge.toLocaleString('zh-CN')}</span> : <span className="context-nav-arrow" aria-hidden="true">›</span>}
        </Link>)}
      </nav>
      <div className="sidebar-bottom">

        <div className="sidebar-user">
          <span className="avatar-initial">{workbookMode ? localRoleLabel(workbook?.role).slice(0, 1) : session.actor.displayName.slice(0, 1)}</span>
          <span className="user-copy"><strong>{workbookMode ? localRoleLabel(workbook?.role) : session.actor.displayName}</strong><small>{workbookMode ? localRoleLabel(workbook?.role) : roleLabel(session.actor.role)}</small></span>
        </div>
      </div>
    </aside>
  );
}

export default function Layout() {
  const { session, workspace } = useWorkbench();
  const business = session.businessWorkspace;
  const workbook = business ? null : getWorkbookContext(session);
  const historyContext = business ? getWorkbookContext(session) : null;
  const location = useLocation();
  useEffect(() => {
    document.getElementById('main-content')?.parentElement?.scrollTo(0, 0);
  }, [location.pathname]);
  const localRole = workbook?.role ?? 'local_manager';
  const currentSourceSha = workbook?.sourceSha256 ?? '';
  const requestedYear = new URLSearchParams(location.search).get('year');
  const localYear = requestedYear === 'all' ? undefined : /^\d{4}$/u.test(requestedYear ?? '') ? Number(requestedYear) : 2026;
  const workbookMode = Boolean(workbook);
  const navigationSummaryFilters = {
    ...(currentSourceSha ? { sourceSha256: currentSourceSha } : {}),
    ...(localYear ? { year: localYear } : {}),
  };
  const localSummaryQuery = useQuery({
    queryKey: workbook ? workbookSummaryQueryKey(workbook, navigationSummaryFilters) : ['workbook', 'summary', 'disabled'],
    queryFn: () => workbook ? getWorkbookSummary(navigationSummaryFilters, workbook) : Promise.reject(new Error('工作簿工作区未就绪。')),
    enabled: workbookMode,
    staleTime: 30_000,
  });
  const unknownCount = (localSummaryQuery.data?.sourceStatusCounts ?? []).reduce((total, item) =>
    item.platform === 'unknown' && (item.kind === 'samples' || item.kind === 'broadcast') ? total + item.count : total, 0);
  const historyFilters = { kind: 'samples' as const, year: 2026 };
  const historySummaryQuery = useQuery({
    queryKey: historyContext ? workbookSummaryQueryKey(historyContext, historyFilters) : ['workbook', 'summary', 'business-disabled'],
    queryFn: () => historyContext ? getWorkbookSummary(historyFilters, historyContext) : Promise.reject(new Error('历史资料未就绪。')),
    enabled: Boolean(historyContext),
    staleTime: 30_000,
  });
  const sampleHistoryCount = historySummaryQuery.data?.totals.rows;
  const modules = useMemo(() => {
    const built = workbook ? withBrandRoute(getLocalNavigationModules(localRole, unknownCount), session.canManageBrands === true) : (business ? getBusinessNavigationModules({
      role: session.actor.role,
      capabilities: session.actor.capabilities,
      canSeeTeamMetrics: workspace.scope.canSeeTeamMetrics,
    }, session.canManageBrands === true) : getNavigationModules({
      role: session.actor.role,
      capabilities: session.actor.capabilities,
      canSeeTeamMetrics: workspace.scope.canSeeTeamMetrics,
    }));
    if (typeof sampleHistoryCount !== 'number') return built;
    return built.map((item) => ({
      ...item,
      routes: item.routes.map((entry) => entry.id === 'source-samples' ? { ...entry, badge: sampleHistoryCount } : entry),
    }));
  }, [session.dataMode, session.canManageBrands, business, workbook?.storage, localRole, unknownCount, sampleHistoryCount, session.actor.role, session.actor.capabilities, workspace.scope.canSeeTeamMetrics]);
  const activeModule = getActiveNavigationModule(modules, location.pathname) ?? modules[0];
  const activeRoute = getActiveNavigationRoute(activeModule, location.pathname, location.search);
  const hideSidebar = Boolean(business && (location.pathname === '/' || activeModule.routes.length <= 1));
  const actorKey = JSON.stringify({
    memberId: session.actor.memberId,
    role: session.actor.role,
    teamId: session.actor.teamId,
    capabilities: [...session.actor.capabilities].sort(),
    scope: {
      teamIds: [...workspace.scope.teamIds].sort(),
      canSeeTeamMetrics: workspace.scope.canSeeTeamMetrics,
      canManageMembers: workspace.scope.canManageMembers,
    },
  });

  if ((workbookMode && location.pathname === '/data-screen')
    || (business && location.pathname === '/source-records/data-screen')) {
    return <div className="local-data-screen-frame"><Outlet /></div>;
  }

  const shell = (
    <div className={`app-frame navigation-shell${workbookMode ? ' local-navigation-shell' : ''}${business ? ' business-navigation-shell' : ''}${hideSidebar ? ' navigation-shell--full-width' : ''}`}>
      <TopBar modules={modules} activeModule={activeModule} activeRouteId={activeRoute?.id} />
      {workbookMode && <div className="local-platform-strip"><LocalPlatformTabs unknownCount={unknownCount} /></div>}
      {!hideSidebar && <Sidebar module={activeModule} activeRouteId={activeRoute?.id} localScopeRoutes={modules.find((item) => item.id === 'work')?.routes.filter((item) => item.id === 'local-home' || item.id === 'local-unknown') ?? []} />}
      <div className="app-main">
        {session.dataMode === 'demo' && <DemoSwitch />}
        <main className="main-content" id="main-content">
          {workbook ? <Outlet /> : <WalkthroughProvider actorKey={actorKey} dataMode={session.dataMode === 'demo' ? 'demo' : 'production'}>
            <WalkthroughDock />
            <Outlet />
          </WalkthroughProvider>}
        </main>

      </div>
    </div>
  );
  return workbook ? shell : <OnboardingGuideProvider>{shell}</OnboardingGuideProvider>;
}
