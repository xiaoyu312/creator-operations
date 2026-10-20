import type { Capability, Role } from '../../../shared/types.ts';
import type { LocalWorkbookActor } from '../../../shared/workbook.ts';

export type NavigationModuleId = 'work' | 'creators' | 'products' | 'samples' | 'broadcast' | 'data' | 'team';

export interface NavigationRoute {
  id: string;
  label: string;
  to: string;
  pathname: string;
  matchQuery?: Readonly<Record<string, string>>;
  defaultWhenQueryMissing?: boolean;
  badge?: number;
}

export interface NavigationModule {
  id: NavigationModuleId;
  label: string;
  to: string;
  routes: NavigationRoute[];
}

export interface NavigationContext {
  role: Role;
  capabilities: readonly Capability[];
  canSeeTeamMetrics: boolean;
}

export function getLocalNavigationModules(role: LocalWorkbookActor['role'] = 'local_manager', unknownCount = 0): NavigationModule[] {
  const overviewRoutes = [
    route('local-home', '全部记录', '/'),
    ...(unknownCount > 0 ? [route('local-unknown', '待核对', '/?platform=unknown', { matchQuery: { platform: 'unknown' }, badge: unknownCount })] : []),
    ...(role === 'local_manager' ? [route('local-data-screen', '管理数据大屏', '/data-screen')] : []),
    route('local-guide', '使用说明', '/guide'),
  ];
  const modules = [module('work', '工作台', overviewRoutes)];
  if (role !== 'local_links') {
    modules.push(module('samples', role === 'local_shipping' ? '寄样队列' : role === 'local_bd' ? '寄样需求' : '寄样处理', [
      route('local-samples', role === 'local_bd' ? '登记寄样需求' : role === 'local_shipping' ? '待处理寄样' : '寄样记录', '/samples'),
    ]));
  }
  if (role !== 'local_shipping') {
    modules.push(module('broadcast', role === 'local_links' ? '上播设置' : '上播资料', [
      route('local-broadcast', role === 'local_links' ? '链接设置队列' : '上播设置记录', '/schedule'),
    ]));
  }
  return modules.map((item) => item.id === 'samples' ? { ...item, label: '寄样', to: '/samples' }
    : item.id === 'broadcast' ? { ...item, label: '上播设置', to: '/schedule' }
      : item.id === 'work' ? { ...item, to: '/' } : item);
}

function route(id: string, label: string, to: string, options: Pick<NavigationRoute, 'matchQuery' | 'defaultWhenQueryMissing' | 'badge'> = {}): NavigationRoute {
  const url = new URL(to, 'https://navigation.invalid');
  return { id, label, to, pathname: url.pathname, ...options };
}

function module(id: NavigationModuleId, label: string, routes: NavigationRoute[]): NavigationModule {
  return { id, label, to: routes[0]?.to ?? '/', routes };
}

export function getNavigationModules({ role, capabilities, canSeeTeamMetrics }: NavigationContext): NavigationModule[] {
  const isManager = role === 'manager' || role === 'admin';
  const isOps = role === 'ops';
  const modules: NavigationModule[] = [
    module('work', '工作台', [
      route('today', '今日工作台', '/'),
      route('tasks', '跟进任务', '/tasks'),
      route('guide', '入门指南', '/guide'),
    ]),
  ];

  if (!isOps) {
    const creatorRoutes = isManager
      ? [
          route('creators-team', '团队达人', '/creators?scope=team', { matchQuery: { scope: 'team' }, defaultWhenQueryMissing: true }),
          route('creators-mine', '我的达人', '/creators?scope=mine', { matchQuery: { scope: 'mine' } }),
        ]
      : [route('creators-mine', '我的达人', '/creators?scope=mine', { matchQuery: { scope: 'mine' }, defaultWhenQueryMissing: true })];
    creatorRoutes.push(route('public-pool', '公海达人', '/public-pool'));
    creatorRoutes.push(route('partners', '团长与机构', '/partners'));
    modules.push(module('creators', '达人', creatorRoutes));

    const productRoutes = [
      route('assortments', isManager ? '货盘维护' : '可用货盘', '/assortments'),
      ...(isManager ? [route('products', '商品目录', '/products')] : []),
      route('proposals', '推品提案', '/proposals'),
      route('stores', role === 'bd' ? '店铺资料' : '店铺资料', '/stores'),
    ];
    modules.push(module('products', '商品', productRoutes));
  }

  modules.push(module('samples', '样品', [route('samples', '样品申请', '/samples')]));

  if (!isOps) {
    modules.push(module('broadcast', '上播设置', [route('schedule', '上播设置', '/schedule')]));
  }

  const dataRoutes = [
    ...(canSeeTeamMetrics ? [route('dashboard', '团队看板', '/dashboard')] : []),
    ...(!isOps ? [route('orders', '订单与退款', '/orders')] : []),
    ...(isManager ? [route('targets', '团队月目标', '/targets')] : []),
  ];
  if (dataRoutes.length) modules.push(module('data', '数据', dataRoutes));

  const teamRoutes = [
    ...(isManager ? [route('team', role === 'manager' ? '团队交接' : '成员与交接', '/team'), route('rules', '业务规则', '/rules')] : []),
    ...(capabilities.includes('audit.read') ? [route('audit', '操作记录', '/audit')] : []),
  ];
  if (teamRoutes.length) modules.push(module('team', '团队', teamRoutes));

  return modules;
}

/** Connected modules share a brand; source sheets remain traceable historical input. */
export function getBusinessNavigationModules(context: NavigationContext, canManageBrands: boolean): NavigationModule[] {
  const existing = getNavigationModules(context);
  const isManager = context.role === 'admin' || context.role === 'manager';
  const modules = existing.filter((item) => !['broadcast', 'data', 'team'].includes(item.id)).map((item) => {
    if (item.id === 'products') return module('products', '商品', [route('products', '商品列表', '/products')]);
    if (item.id === 'samples') return module('samples', '寄样', [
      route('samples', '寄样管理', '/samples'),
      route('source-samples', '寄样历史', '/source-records/samples'),
    ]);
    return {
      ...item,
      routes: [
        ...item.routes.filter((entry) => entry.id !== 'partners').map((entry) =>
          entry.id === 'today' ? { ...entry, label: '经营工作台' } : entry),
        ...(item.id === 'work' ? [
        route('source-records', '历史资料', '/source-records'),
        ...(context.role !== 'ops' ? [route('source-broadcast', '上播历史', '/source-records/broadcast')] : []),
        ...(isManager ? [route('source-data-screen', '历史资料大屏', '/source-records/data-screen')] : []),
        ] : []),
      ],
    };
  });
  const performanceRoutes = context.role !== 'ops' || context.canSeeTeamMetrics
    ? [route('dashboard', '业绩概览', '/team?tab=performance', { matchQuery: { tab: 'performance' }, defaultWhenQueryMissing: true })]
    : [];
  if (context.role !== 'ops') performanceRoutes.push(route('orders', '订单与退款', '/orders'));
  if (isManager) performanceRoutes.push(
    route('business-progress', '商务进度', '/team?tab=progress', { matchQuery: { tab: 'progress' } }),
    route('team', '团队管理', '/team?tab=management', { matchQuery: { tab: 'management' } }),
    route('rules', '业务规则', '/rules'),
  );
  if (isManager && context.capabilities.includes('audit.read')) performanceRoutes.push(route('audit', '操作记录', '/audit'));
  if (isManager && canManageBrands) performanceRoutes.push(route('brands', '品牌与成员', '/brands'));
  if (context.role !== 'ops') {
    const schedule = module('broadcast', '排期', [route('schedule', '直播排期', '/schedule')]);
    const sampleIndex = modules.findIndex((item) => item.id === 'samples');
    modules.splice(sampleIndex + 1, 0, schedule);
  }
  if (performanceRoutes.length) modules.push(module('team', '团队与业绩', performanceRoutes));
  return modules;
}

export function getActiveNavigationRoute(moduleConfig: NavigationModule, pathname: string, search = ''): NavigationRoute | null {
  const params = new URLSearchParams(search);
  const samePath = moduleConfig.routes.filter((item) => item.pathname === pathname);
  for (const item of samePath) {
    if (!item.matchQuery) return item;
    const allMissing = Object.keys(item.matchQuery).every((key) => params.get(key) === null);
    const matches = Object.entries(item.matchQuery).every(([key, value]) => params.get(key) === value);
    if (matches || (item.defaultWhenQueryMissing && allMissing)) return item;
  }
  return null;
}

export function getActiveNavigationModule(modules: NavigationModule[], pathname: string): NavigationModule | null {
  const matches = modules.filter((item) => item.routes.some((routeItem) => routeItem.pathname === pathname));
  if (pathname === '/source-records/samples') return matches.find((item) => item.id === 'samples') ?? matches[0] ?? null;
  if (pathname === '/schedule') return matches.find((item) => item.id === 'broadcast') ?? matches[0] ?? null;
  if (matches[0]) return matches[0];
  if (pathname === '/dashboard') return modules.find((item) => item.routes.some((entry) => entry.id === 'dashboard')) ?? null;
  if (['/assortments', '/stores', '/proposals'].includes(pathname)) return modules.find((item) => item.id === 'products') ?? null;
  if (pathname === '/cooperations') return modules.find((item) => item.id === 'creators') ?? null;
  return null;
}
