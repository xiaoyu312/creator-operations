import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { CalendarClock, ChevronDown, Copy, ExternalLink, Filter, LayoutGrid, List, MessageSquarePlus, MoreHorizontal, Plus, Search, UserRoundCheck, X } from 'lucide-react';
import type { Creator, CreatorAccount, CreatorCommerceType, CrmStage, FollowupChannel, FollowupResult, Platform } from '@shared/types';
import { CRM_STAGES } from '@shared/types';
import { useWorkbench } from '../workbench-context';
import { Button } from '../components/ui/button';
import { Checkbox } from '../components/ui/checkbox';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../components/ui/sheet';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { EmptyState, FormField, Modal, ModalActivityBoundary, PageHeading, StatusPill, formatDate, formatDateTime, formatMoney, shanghaiDateKey, shanghaiDateTimeInput, shanghaiInputToIso, statusLabel } from '../components/workbench';
import { creatorIdentityGroup, creatorOrderAttribution } from '../utils/creator-attribution';
import { compareTimestamps } from '../lib/time';
import { creatorMatchesCommerceType, type CommerceTypeFilter } from '../lib/creator-commerce';
import { creatorCreatedDestination, creatorsInVisibleScope, isImplicitDefaultCreatorPlatform } from '../lib/creator-list';
import { CreatorCooperationPanel } from '../components/CreatorCooperationPanel';
import CreatorSessionHistory from '../components/CreatorSessionHistory';
import { EmptyIllustration } from '../components/ProductVisuals';
import { accountForPlatform, accountsForPlatform, creatorHasPlatform, creatorPlatformOptions, isPlatform, platformLabel, type CreatorPlatformFilter } from '../lib/platform-presentation';
import '../creators-reference.css';

const stageLabels: Record<CrmStage, string> = {
  uncontacted: '未建联', contacted: '已触达', responded: '有回应', negotiating: '洽谈中', cooperating: '合作中', paused: '暂停', declined: '不合作',
};
const stageOrder: CrmStage[] = ['uncontacted', 'contacted', 'responded', 'negotiating', 'cooperating', 'paused', 'declined'];
const channelLabels: Record<FollowupChannel, string> = { phone: '电话', wechat: '微信', platform_dm: '平台私信', email: '邮件', meeting: '会议', other: '其他' };
const resultLabels: Record<FollowupResult, string> = { no_answer: '未接通', contacted: '已触达', responded: '有回应', negotiating: '洽谈中', not_interested: '暂不合作', other: '其他' };
const commerceTypeLabels: Record<CreatorCommerceType, string> = { short_video: '短视频带货', live: '直播带货' };
const commerceFilterLabels: Record<CommerceTypeFilter, string> = { all: '全部类型', short_video: '短视频带货', live: '直播带货', both: '两者都有', unset: '未设置' };

function CommerceTypeBadges({ account }: { account: CreatorAccount }) {
  const types = account.commerceTypes ?? [];
  return <span className="creator-commerce-badges">
    {types.length ? types.map((type) => <span className={`creator-commerce-badge creator-commerce-badge--${type}`} key={type}>{commerceTypeLabels[type]}</span>) : <span className="creator-commerce-badge is-unset">未设置</span>}
  </span>;
}

function accountName(creator: Creator, platform: CreatorPlatformFilter = 'all') { return accountForPlatform(creator.accounts, platform)?.displayName ?? creator.name; }
function sourceLabel(source: string) { return source === 'manual' ? '手工录入' : source === 'csv' ? 'CSV 导入' : source || '—'; }

function creatorScopedHref(path: string, values: Record<string, string>, brandId: string | null) {
  const params = new URLSearchParams(values);
  if (brandId) params.set('brandId', brandId);
  return `${path}?${params.toString()}`;
}

function creatorMatchesSearch(creator: Creator, query: string, platform: CreatorPlatformFilter) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const accounts = accountsForPlatform(creator.accounts, platform);
  return [creator.name, creator.category ?? '', creator.source, ...creator.tags, ...accounts.flatMap((account) => [account.displayName, account.externalAccountId])].some((value) => value.toLowerCase().includes(needle));
}

function isVisibleFocusTarget(target: HTMLElement | null): target is HTMLElement {
  return Boolean(target?.isConnected && target.getClientRects().length > 0);
}

function scheduleFocusAfterLayout(trigger: HTMLElement | null, fallback: () => HTMLElement | null, beforeFocus?: () => void) {
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    beforeFocus?.();
    const target = isVisibleFocusTarget(trigger) ? trigger : fallback();
    if (isVisibleFocusTarget(target)) target.focus({ preventScroll: true });
  }));
}

function focusAfterDialogClose(event: Event, trigger: HTMLElement | null, fallback: () => HTMLElement | null, beforeFocus?: () => void) {
  event.preventDefault();
  scheduleFocusAfterLayout(trigger, fallback, beforeFocus);
}

export default function CreatorsPage({ publicPool = false }: { publicPool?: boolean }) {
  const { workspace, session } = useWorkbench();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const currentBrandId = session.businessWorkspace?.brandId ?? session.workbook?.brandId ?? searchParams.get('brandId');
  const stageParam = searchParams.get('stage') ?? '';
  const stageFilter: CrmStage | 'all' = (stageOrder as string[]).includes(stageParam) ? stageParam as CrmStage : 'all';
  const setStageFilter = (value: CrmStage | 'all') => {
    const next = new URLSearchParams(searchParams);
    if (value === 'all') next.delete('stage'); else next.set('stage', value);
    setSearchParams(next, { replace: true });
  };
  const platformParam = searchParams.get('platform') ?? '';
  const platformFilter: CreatorPlatformFilter = platformParam === 'all' || isPlatform(platformParam) ? platformParam : 'douyin';
  const commerceTypeParam = searchParams.get('commerceType') ?? 'all';
  const commerceTypeFilter: CommerceTypeFilter = commerceTypeParam === 'short_video' || commerceTypeParam === 'live' || commerceTypeParam === 'both' || commerceTypeParam === 'unset'
    ? commerceTypeParam
    : 'all';
  const [quickView, setQuickView] = useState<'all' | 'followup'>('all');
  const [view, setView] = useState<'table' | 'kanban'>('table');
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);
  const creatorTriggerRef = useRef<HTMLElement | null>(null);
  const followupTriggerRef = useRef<HTMLElement | null>(null);
  const createTriggerRef = useRef<HTMLElement | null>(null);
  const detailCloseScrollRef = useRef<{ element: HTMLElement; top: number } | null>(null);
  const lastRequestedCreatorIdRef = useRef<string | null>(null);
  const [followupTargetId, setFollowupTargetId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [page, setPage] = useState(1);
  const pageRootRef = useRef<HTMLDivElement | null>(null);
  const [inlineDetailEnabled, setInlineDetailEnabled] = useState(false);
  const query = searchParams.get('q') ?? '';
  const [queryDraft, setQueryDraft] = useState(() => searchParams.get('q') ?? '');
  const queryComposingRef = useRef(false);
  const mine = workspace.actor.memberId;
  const managerView = workspace.actor.role === 'manager' || workspace.actor.role === 'admin';
  const canCreateCreator = session.actor.role !== 'ops';
  const canMakePublic = managerView;
  const creatorScope = publicPool ? 'public' : managerView && searchParams.get('scope') !== 'mine' ? 'team' : 'mine';
  const ownerFilter = creatorScope === 'team' ? searchParams.get('ownerMemberId') ?? 'all' : 'all';
  const teamFilter = creatorScope === 'team' ? searchParams.get('teamId') ?? 'all' : 'all';
  const allowedTeamIds = workspace.scope.teamIds;
  const dashboardFrom = searchParams.get('dateFrom');
  const dashboardTo = searchParams.get('dateTo');
  const requestedCreatorId = searchParams.get('creatorId');

  useEffect(() => {
    if (searchParams.get('create') === '1' && canCreateCreator) setCreateOpen(true);
  }, [searchParams, canCreateCreator]);

  useEffect(() => {
    if (!queryComposingRef.current) setQueryDraft(query);
  }, [query]);

  const visibleScopeCreatorCandidates = useMemo(() => creatorsInVisibleScope(workspace.creators, {
    view: publicPool ? 'public' : creatorScope,
    allowedTeamIds,
    teamId: teamFilter,
    ownerMemberId: ownerFilter,
    memberId: mine,
  }), [workspace.creators, publicPool, creatorScope, allowedTeamIds, teamFilter, ownerFilter, mine]);

  useEffect(() => {
    if (!requestedCreatorId) {
      lastRequestedCreatorIdRef.current = null;
      return;
    }
    if (lastRequestedCreatorIdRef.current === requestedCreatorId) return;
    lastRequestedCreatorIdRef.current = requestedCreatorId;
    if (visibleScopeCreatorCandidates.some((creator) => creator.id === requestedCreatorId)) {
      setSelectedCreatorId(requestedCreatorId);
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.delete('creatorId');
    setSearchParams(next, { replace: true });
  }, [requestedCreatorId, visibleScopeCreatorCandidates, searchParams, setSearchParams]);
  const scopedCreators = useMemo(() => {
    return workspace.creators.filter((creator) => {
      if (publicPool) {
        if (creator.ownerMemberId !== null || !allowedTeamIds.includes(creator.teamId)) return false;
        if (teamFilter !== 'all' && creator.teamId !== teamFilter) return false;
      } else if (creatorScope === 'team') {
        if (!allowedTeamIds.includes(creator.teamId)) return false;
        if (teamFilter !== 'all' && creator.teamId !== teamFilter) return false;
        if (creator.ownerMemberId === null) return false;
        if (ownerFilter !== 'all' && creator.ownerMemberId !== ownerFilter) return false;
      } else if (creator.ownerMemberId !== mine) return false;
      if (!creatorHasPlatform(creator.accounts, platformFilter)) return false;
      if (!creatorMatchesCommerceType(creator.accounts, platformFilter, commerceTypeFilter)) return false;
      return creatorMatchesSearch(creator, query, platformFilter);
    }).sort((a, b) => compareTimestamps(a.updatedAt, b.updatedAt, 'desc'));
  }, [workspace.creators, publicPool, creatorScope, allowedTeamIds, teamFilter, ownerFilter, mine, query, platformFilter, commerceTypeFilter]);
  const actionCreatorIds = useMemo(() => new Set(workspace.tasks.filter((task) => task.status === 'open' && task.creatorId && (workspace.actor.role !== 'bd' || task.ownerMemberId === mine) && (task.kind === 'followup' || Boolean(task.dueAt && Date.parse(task.dueAt) < Date.now()))).map((task) => task.creatorId!)), [workspace.tasks, workspace.actor.role, mine]);
  const stageScopedCreators = useMemo(() => stageFilter === 'all' ? scopedCreators : scopedCreators.filter((creator) => creator.crmStage === stageFilter), [scopedCreators, stageFilter]);
  const stageCounts = useMemo(() => Object.fromEntries(stageOrder.map((stage) => [stage, scopedCreators.filter((creator) => creator.crmStage === stage).length])) as Record<CrmStage, number>, [scopedCreators]);
  const followupCount = scopedCreators.filter((creator) => actionCreatorIds.has(creator.id)).length;
  const publicPoolCount = publicPool
    ? scopedCreators.length
    : workspace.creators.filter((creator) => creator.ownerMemberId === null && allowedTeamIds.includes(creator.teamId) && creatorHasPlatform(creator.accounts, platformFilter) && creatorMatchesCommerceType(creator.accounts, platformFilter, commerceTypeFilter) && creatorMatchesSearch(creator, query, platformFilter)).length;
  const creators = useMemo(() => quickView === 'followup'
    ? scopedCreators.filter((creator) => actionCreatorIds.has(creator.id))
    : stageScopedCreators, [scopedCreators, stageScopedCreators, quickView, actionCreatorIds]);
  const selectAllView = () => { setQuickView('all'); setStageFilter('all'); setPage(1); };
  const selectFollowupTab = () => { setQuickView('followup'); setStageFilter('all'); setPage(1); };
  const pageSize = 12;
  const pages = Math.max(1, Math.ceil(creators.length / pageSize));
  const visible = creators.slice((page - 1) * pageSize, page * pageSize);
  const selectedCurrent = selectedCreatorId ? visibleScopeCreatorCandidates.find((creator) => creator.id === selectedCreatorId) ?? null : null;
  const followupCreator = followupTargetId ? workspace.creators.find((creator) => creator.id === followupTargetId) ?? null : null;
  const followupAccount = followupCreator ? accountForPlatform(followupCreator.accounts, platformFilter) : undefined;

  const changeSearch = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set('q', value); else next.delete('q');
    setSearchParams(next, { replace: true });
    setPage(1);
  };
  const changePlatform = (value: CreatorPlatformFilter) => {
    const next = new URLSearchParams(searchParams);
    next.set('platform', value);
    setSearchParams(next, { replace: true });
    setPage(1);
  };
  const changeCommerceType = (value: CommerceTypeFilter) => {
    const next = new URLSearchParams(searchParams);
    if (value === 'all') next.delete('commerceType'); else next.set('commerceType', value);
    setSearchParams(next, { replace: true });
    setPage(1);
  };
  const changeScope = (nextScope: 'team' | 'mine') => {
    const next = new URLSearchParams(searchParams);
    next.set('scope', nextScope);
    if (nextScope === 'mine') next.delete('ownerMemberId');
    setSearchParams(next);
    setPage(1);
  };
  const changeOwner = (value: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('scope', 'team');
    if (value === 'all') next.delete('ownerMemberId'); else next.set('ownerMemberId', value);
    setSearchParams(next);
    setPage(1);
  };
  const changeTeam = (value: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('scope', 'team');
    if (value === 'all') next.delete('teamId'); else next.set('teamId', value);
    next.delete('ownerMemberId');
    setSearchParams(next);
    setPage(1);
  };
  const changeStage = (value: CrmStage | 'all') => {
    setQuickView('all');
    setStageFilter(value);
    setPage(1);
  };
  const title = publicPool ? '公海达人' : creatorScope === 'team' ? '团队达人' : '我的达人';
  const canFilterTeam = allowedTeamIds.length > 1 && !publicPool && creatorScope === 'team';
  const canFilterOwner = !publicPool && creatorScope === 'team';
  const canExpandFilters = true;
  const ignoreImplicitDefaultPlatformFilter = isImplicitDefaultCreatorPlatform(platformFilter, searchParams.has('platform'), visibleScopeCreatorCandidates.length > 0);
  const filtersHaveValues = Boolean(query.trim()) || (platformFilter !== 'all' && !ignoreImplicitDefaultPlatformFilter) || commerceTypeFilter !== 'all' || stageFilter !== 'all' || quickView !== 'all' || teamFilter !== 'all' || ownerFilter !== 'all';
  const hasActiveCreators = workspace.creators.some((creator) => !creator.archived && !creator.mergedIntoCreatorId);
  const initialEmpty = !hasActiveCreators && !filtersHaveValues;
  const clearFilters = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('q');
    next.delete('teamId');
    next.delete('ownerMemberId');
    next.delete('commerceType');
    next.delete('stage');
    next.set('platform', 'all');
    setSearchParams(next, { replace: true });
    setQuickView('all');
    setPage(1);
  };
  const publicQuery = new URLSearchParams(searchParams);
  publicQuery.delete('scope');
  publicQuery.delete('ownerMemberId');
  publicQuery.delete('creatorId');
  publicQuery.delete('create');
  const publicPoolHref = `/public-pool${publicQuery.toString() ? `?${publicQuery.toString()}` : ''}`;
  const openCreatorDetail = (creator: Creator, trigger: HTMLElement) => {
    creatorTriggerRef.current = trigger;
    setSelectedCreatorId(creator.id);
  };
  const restoreCreatorFocus = () => {
    const closingCreatorId = selectedCreatorId;
    const scrollSnapshot = detailCloseScrollRef.current;
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      if (scrollSnapshot?.element.isConnected) scrollSnapshot.element.scrollTop = scrollSnapshot.top;
      const rowTrigger = closingCreatorId ? document.querySelector<HTMLElement>(`[data-creator-open-id="${CSS.escape(closingCreatorId)}"]`) : null;
      const savedTrigger = creatorTriggerRef.current;
      const target = savedTrigger?.dataset.creatorOpenId === closingCreatorId && isVisibleFocusTarget(savedTrigger) ? savedTrigger : rowTrigger;
      creatorTriggerRef.current = null;
      if (isVisibleFocusTarget(target)) target.focus({ preventScroll: true });
      else pageRootRef.current?.focus({ preventScroll: true });
    }));
  };
  const closeCreatorDetail = () => {
    const scrollElement = pageRootRef.current?.closest<HTMLElement>('.app-main') ?? null;
    detailCloseScrollRef.current = scrollElement ? { element: scrollElement, top: scrollElement.scrollTop } : null;
    setSelectedCreatorId(null);
    if (searchParams.has('creatorId')) {
      const next = new URLSearchParams(searchParams);
      next.delete('creatorId');
      setSearchParams(next, { replace: true });
    }
    restoreCreatorFocus();
  };
  const activeFilterChips = [
    query.trim() ? { key: 'query', label: `搜索：${query.trim()}`, clear: () => changeSearch('') } : null,
    (platformFilter !== 'all' && !ignoreImplicitDefaultPlatformFilter) ? { key: 'platform', label: `平台：${platformLabel(platformFilter)}`, clear: () => changePlatform('all') } : null,
    commerceTypeFilter !== 'all' ? { key: 'commerce', label: `带货类型：${commerceFilterLabels[commerceTypeFilter]}`, clear: () => changeCommerceType('all') } : null,
    stageFilter !== 'all' ? { key: 'stage', label: `阶段：${stageLabels[stageFilter]}`, clear: () => { setStageFilter('all'); setPage(1); } } : null,
    teamFilter !== 'all' ? { key: 'team', label: `团队：${workspace.teams.find((team) => team.id === teamFilter)?.name ?? '已选团队'}`, clear: () => { const next = new URLSearchParams(searchParams); next.delete('teamId'); setSearchParams(next, { replace: true }); setPage(1); } } : null,
    ownerFilter !== 'all' ? { key: 'owner', label: `负责人：${workspace.members.find((member) => member.id === ownerFilter)?.displayName ?? '已选负责人'}`, clear: () => { const next = new URLSearchParams(searchParams); next.delete('ownerMemberId'); setSearchParams(next, { replace: true }); setPage(1); } } : null,
    quickView === 'followup' ? { key: 'quickView', label: '视图：待跟进', clear: () => setQuickView('all') } : null,
  ].filter((chip): chip is { key: string; label: string; clear: () => void } => chip !== null);
  useEffect(() => {
    const pageRoot = pageRootRef.current;
    if (!pageRoot) return;
    const syncInlineLayout = () => setInlineDetailEnabled(pageRoot.getBoundingClientRect().width >= 1100 || window.innerWidth >= 1400);
    syncInlineLayout();
    const observer = new ResizeObserver(syncInlineLayout);
    observer.observe(pageRoot);
    window.addEventListener('resize', syncInlineLayout);
    return () => { observer.disconnect(); window.removeEventListener('resize', syncInlineLayout); };
  }, []);
  useEffect(() => {
    if (!selectedCreatorId || selectedCurrent) return;
    setSelectedCreatorId(null);
    if (searchParams.has('creatorId')) {
      const next = new URLSearchParams(searchParams);
      next.delete('creatorId');
      setSearchParams(next, { replace: true });
    }
  }, [selectedCreatorId, selectedCurrent, searchParams, setSearchParams]);
  const openCreateDialog = (trigger?: HTMLElement) => {
    if (trigger) createTriggerRef.current = trigger;
    setCreateOpen(true);
  };
  const getPageFocusFallback = () => pageRootRef.current;
  const restorePageDialogFocus = (triggerRef: { current: HTMLElement | null }, fallback: () => HTMLElement | null = getPageFocusFallback) => (event: Event) => {
    const trigger = triggerRef.current;
    triggerRef.current = null;
    focusAfterDialogClose(event, trigger, fallback);
  };
  const getFollowupFocusFallback = () => {
    const creatorId = followupTargetId;
    return (creatorId ? document.querySelector<HTMLElement>(`[data-followup-creator-id="${CSS.escape(creatorId)}"]`) : null) ?? getPageFocusFallback();
  };
  const handleListFollowupOpenChange = (open: boolean) => {
    if (open) return;
    scheduleFocusAfterLayout(followupTriggerRef.current, getFollowupFocusFallback);
    setFollowupTargetId(null);
  };
  const handleCreateDialogOpenChange = (open: boolean, created = false) => {
    setCreateOpen(open);
    if (!open && !created && searchParams.has('create')) {
      const next = new URLSearchParams(searchParams);
      next.delete('create');
      setSearchParams(next, { replace: true });
    }
  };
  const emptyAction = filtersHaveValues
    ? <Button size="sm" variant="outline" onClick={clearFilters}>清除筛选</Button>
    : publicPool || !canCreateCreator ? undefined : <Button size="sm" variant="outline" onClick={(event) => openCreateDialog(event.currentTarget)}><Plus size={14} />新建达人</Button>;

  const showInlineDetail = Boolean(selectedCurrent && inlineDetailEnabled);
  return (
    <div ref={pageRootRef} tabIndex={-1} className="page-stack creator-reference-page">
      <PageHeading title={title} />
      <section className="creator-filter-panel" aria-label="达人筛选">
        <div className="creator-filter-grid">
          <label className="creator-filter-field creator-search-filter">
            <span>搜索</span>
            <div className="search-field"><Search size={14} aria-hidden="true" /><input value={queryDraft} onChange={(event) => { setQueryDraft(event.target.value); if (!queryComposingRef.current) changeSearch(event.target.value); }} onCompositionStart={() => { queryComposingRef.current = true; }} onCompositionEnd={(event) => { queryComposingRef.current = false; setQueryDraft(event.currentTarget.value); changeSearch(event.currentTarget.value); }} placeholder="达人名称、账号昵称或标签" aria-label="搜索达人名称、平台账号或标签" /></div>
          </label>
          {managerView && !publicPool && <div className="creator-filter-field">
            <span>查看范围</span>
            <div className="creator-scope-toggle" role="group" aria-label="切换达人查看范围">
              <Button variant={creatorScope === 'team' ? 'secondary' : 'ghost'} size="sm" onClick={() => changeScope('team')} aria-pressed={creatorScope === 'team'}>团队达人</Button>
              <Button variant={creatorScope === 'mine' ? 'secondary' : 'ghost'} size="sm" onClick={() => changeScope('mine')} aria-pressed={creatorScope === 'mine'}>只看我负责</Button>
            </div>
          </div>}
          <div className="creator-filter-actions">
            <button className="creator-filter-toggle" type="button" aria-expanded={filtersExpanded} aria-controls="creator-advanced-filters" onClick={() => setFiltersExpanded((expanded) => !expanded)}><Filter size={14} aria-hidden="true" />{filtersExpanded ? '收起筛选' : '展开筛选'}<ChevronDown size={14} aria-hidden="true" /></button>
          </div>
        </div>
        {activeFilterChips.length > 0 && <div className="creator-active-filters" aria-label="已选筛选条件">
          <span className="creator-active-filters-label">已选</span>
          {activeFilterChips.map((chip) => <button className="creator-filter-chip" key={chip.key} type="button" onClick={chip.clear} aria-label={`清除${chip.label}`}>
            <span>{chip.label}</span><X size={13} aria-hidden="true" />
          </button>)}
          <Button variant="ghost" size="sm" onClick={clearFilters}>清空筛选</Button>
        </div>}
        {filtersExpanded && canExpandFilters && <div className="creator-advanced-filters" id="creator-advanced-filters">
          <label className="owner-filter"><span>平台</span><Select value={platformFilter} onValueChange={(value) => changePlatform(value as CreatorPlatformFilter)}>
            <SelectTrigger className="filter-select" aria-label="按平台筛选达人账号"><SelectValue /></SelectTrigger>
            <SelectContent>{creatorPlatformOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select></label>
          <label className="owner-filter"><span>阶段</span><Select value={stageFilter} onValueChange={(value) => changeStage(value as CrmStage | 'all')}>
            <SelectTrigger className="filter-select" aria-label="按建联阶段筛选"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">全部阶段</SelectItem>{stageOrder.map((stage) => <SelectItem key={stage} value={stage}>{stageLabels[stage]} · {stageCounts[stage]}</SelectItem>)}</SelectContent>
          </Select></label>
          <label className="owner-filter"><span>带货类型</span><Select value={commerceTypeFilter} onValueChange={(value) => changeCommerceType(value as CommerceTypeFilter)}>
            <SelectTrigger className="filter-select" aria-label="按带货类型筛选"><SelectValue /></SelectTrigger>
            <SelectContent>{Object.entries(commerceFilterLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
          </Select></label>
          {canFilterTeam && <label className="owner-filter"><span>团队</span><select value={teamFilter} onChange={(event) => changeTeam(event.target.value)} aria-label="按团队筛选"><option value="all">全部团队</option>{workspace.teams.filter((team) => allowedTeamIds.includes(team.id)).map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>}
          {canFilterOwner && <label className="owner-filter"><span>负责人</span><select value={ownerFilter} onChange={(event) => changeOwner(event.target.value)} aria-label="按达人负责人筛选"><option value="all">全部负责人</option>{workspace.members.filter((member) => allowedTeamIds.includes(member.teamId) && (teamFilter === 'all' || member.teamId === teamFilter)).map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select></label>}
        </div>}
        {managerView && !publicPool && (dashboardFrom || dashboardTo) && <p className="creator-scope-context">看板日期：{dashboardFrom ?? '不限'} 至 {dashboardTo ?? '不限'}</p>}
      </section>
      <div className={`creator-workspace-layout${showInlineDetail ? ' has-inline-detail' : ''}`}>
      <section className="creator-list-panel" aria-label="达人列表">
        <div className="tab-row creator-quick-views creator-stage-tabs" role="group" aria-label="按建联阶段查看达人">
          <button className="tab-button" type="button" aria-pressed={quickView === 'all'} onClick={selectAllView}>{publicPool ? '全部公海' : '全部'}<span className="count-badge">{scopedCreators.length}</span></button>
          <button className="tab-button" type="button" aria-pressed={quickView === 'followup'} onClick={selectFollowupTab}>待跟进<span className="count-badge">{followupCount}</span></button>
          {!publicPool && <Link className="tab-button creator-quick-link" to={publicPoolHref}>公海<span className="count-badge">{publicPoolCount}</span></Link>}
        </div>
        <div className="creator-list-toolbar">
          <span className="creator-list-count">共 <strong>{creators.length}</strong> 位达人</span>
          <div className="creator-list-actions">
            <div className="view-toggle" role="group" aria-label="切换达人视图">
              <Button variant={view === 'table' ? 'secondary' : 'ghost'} size="sm" onClick={() => setView('table')} aria-pressed={view === 'table'}><List size={14} />列表</Button>
              <Button variant={view === 'kanban' ? 'secondary' : 'ghost'} size="sm" onClick={() => setView('kanban')} aria-pressed={view === 'kanban'}><LayoutGrid size={14} />阶段</Button>
            </div>
            {canCreateCreator && <Button className="creator-create-action" onClick={(event) => openCreateDialog(event.currentTarget)}><Plus size={14} />新建达人</Button>}
          </div>
        </div>
        {view === 'table' ? (
          creators.length === 0 ? <EmptyState
            title={filtersHaveValues ? '没有匹配的达人或平台账号' : initialEmpty ? '还没有达人' : publicPool ? '公海暂时为空' : creatorScope === 'team' ? '团队暂无已分配负责人的达人' : '还没有负责的达人'}
            description={filtersHaveValues ? query.trim() ? '试试更短的达人名称、账号昵称或账号 ID，或放宽其他筛选条件。' : platformFilter !== 'all' && !ignoreImplicitDefaultPlatformFilter ? `没有绑定${platformLabel(platformFilter)}账号的达人，调整筛选后再试。` : '调整或清除筛选条件后再试。' : initialEmpty ? '先录入达人和平台账号，开始记录建联与合作。' : publicPool ? '新建达人时可放入公海，主管也可交接达人到公海。' : creatorScope === 'team' ? '可通过上方“公海”入口查看待分配达人。' : '可以新建达人，或切换到团队达人查看。'}
            icon={<EmptyIllustration kind="creators" />}
            action={emptyAction}
          /> : (
            <div className="table-wrap"><table className="data-table creator-table"><thead><tr><th>达人</th><th>阶段</th><th>最近跟进</th><th>下一步</th><th className="text-right">操作</th></tr></thead><tbody>
              {visible.map((creator) => <CreatorRow key={creator.id} creator={creator} publicPool={publicPool} platformFilter={platformFilter} selected={selectedCreatorId === creator.id} onOpen={(trigger) => openCreatorDetail(creator, trigger)} onFollowup={(trigger) => { followupTriggerRef.current = trigger; setFollowupTargetId(creator.id); }} />)}
            </tbody></table></div>
          )
        ) : <CreatorKanban creators={creators} publicPool={publicPool} platformFilter={platformFilter} selectedCreatorId={selectedCreatorId} onOpen={openCreatorDetail} />}
        {creators.length > pageSize && <div className="pagination-row"><span>第 {page} / {pages} 页</span><div><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</Button><Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>下一页</Button></div></div>}
      </section>
      <CreatorDetail key={selectedCreatorId ?? 'no-creator'} creator={selectedCurrent} open={Boolean(selectedCurrent)} presentation={showInlineDetail ? 'inline' : 'sheet'} onOpenChange={(open) => { if (!open) closeCreatorDetail(); }} onCloseFocus={restoreCreatorFocus} publicPool={publicPool} selectedPlatform={platformFilter} brandId={searchParams.get('brandId')} />
      </div>
      {followupCreator && <FollowupDialog creator={followupCreator} account={followupAccount} open onOpenChange={handleListFollowupOpenChange} onCloseAutoFocus={restorePageDialogFocus(followupTriggerRef, getFollowupFocusFallback)} />}
      {canCreateCreator && <CreateCreatorDialog open={createOpen} onOpenChange={handleCreateDialogOpenChange} onCloseAutoFocus={restorePageDialogFocus(createTriggerRef)} canMakePublic={canMakePublic} defaultPlatform={platformFilter} onCreated={(makePublic, platform) => {
        const destination = creatorCreatedDestination(makePublic, platform);
        setPage(1);
        setQuickView('all');
        navigate(creatorScopedHref(destination.path, destination.values, currentBrandId));
      }} />}
    </div>
  );
}

function CreatorRow({ creator, publicPool, platformFilter, selected, onOpen, onFollowup }: { creator: Creator; publicPool: boolean; platformFilter: CreatorPlatformFilter; selected: boolean; onOpen: (trigger: HTMLElement) => void; onFollowup: (trigger: HTMLElement) => void }) {
  const { workspace, session } = useWorkbench();
  const latest = workspace.followups.filter((item) => item.creatorId === creator.id).sort((a, b) => compareTimestamps(a.occurredAt, b.occurredAt, 'desc'))[0];
  const task = workspace.tasks.filter((item) => item.creatorId === creator.id && item.status === 'open').sort((a, b) => compareTimestamps(a.dueAt, b.dueAt))[0];
  const visibleAccounts = accountsForPlatform(creator.accounts, platformFilter);
  const platforms = [...new Set(visibleAccounts.map((item) => item.platform))];
  const owner = workspace.members.find((member) => member.id === creator.ownerMemberId);
  const canFollowup = !publicPool && (creator.ownerMemberId === session.actor.memberId || session.actor.role === 'manager' || session.actor.role === 'admin');
  const taskOverdue = Boolean(task?.dueAt && Date.parse(task.dueAt) < Date.now());
  return (
    <tr data-selected={selected ? 'true' : undefined}>
      <td data-label="达人">
        <div className="creator-row-identity">
          <div className="creator-row-title">
            <button className="link-button table-primary" data-creator-open-id={creator.id} aria-pressed={selected} onClick={(event) => onOpen(event.currentTarget)}>{accountName(creator, platformFilter)}</button>
            {platforms.map((platform) => <span className="creator-row-platform" key={platform}>{platformLabel(platform)}</span>)}
          </div>
          <span className="table-secondary">{owner && !publicPool ? owner.displayName : '公海待认领'}{creator.category ? ` · ${creator.category}` : ''}</span>
        </div>
      </td>
      <td data-label="阶段"><StatusPill value={creator.crmStage} label={stageLabels[creator.crmStage]} /></td>
      <td data-label="最近跟进">{latest ? <><span className="table-primary">{resultLabels[latest.result]}</span><span className="table-secondary">{formatDateTime(latest.occurredAt)}</span></> : <span className="text-muted">还没跟进</span>}</td>
      <td data-label="下一步">{task ? <><span className="table-primary">{task.title}</span><span className={`table-secondary${taskOverdue ? ' creator-row-overdue' : ''}`}>{task.dueAt ? `${taskOverdue ? '已逾期 · ' : ''}${formatDateTime(task.dueAt)}` : '不限时间'}</span></> : <span className="text-muted">—</span>}</td>
      <td data-label="操作" className="table-action-cell"><div className="creator-row-actions">{canFollowup
        ? <Button className="creator-row-followup" size="sm" variant="outline" data-followup-creator-id={creator.id} onClick={(event) => onFollowup(event.currentTarget)}><MessageSquarePlus size={13} />记录跟进</Button>
        : <Button className="creator-row-followup" size="sm" variant="outline" data-creator-open-id={creator.id} onClick={(event) => onOpen(event.currentTarget)}>{publicPool ? '查看 / 认领' : '查看档案'}</Button>}</div></td>
    </tr>
  );
}

function CreatorKanban({ creators, publicPool, platformFilter, selectedCreatorId, onOpen }: { creators: Creator[]; publicPool: boolean; platformFilter: CreatorPlatformFilter; selectedCreatorId: string | null; onOpen: (creator: Creator, trigger: HTMLElement) => void }) {
  const columns = stageOrder.slice(0, 6);
  return <div className="kanban-grid">
    {columns.map((stage) => {
      const rows = creators.filter((creator) => creator.crmStage === stage);
      return <section className="kanban-column" key={stage} aria-label={`${stageLabels[stage]}，${rows.length} 位达人`}>
        <header><span className={`kanban-dot stage-${stage}`} /><strong>{stageLabels[stage]}</strong><span className="count-badge">{rows.length}</span></header>
        <div className="kanban-items">{rows.length ? rows.map((creator) => {
          const account = accountForPlatform(creator.accounts, platformFilter);
          return <button className={`creator-kanban-item${selectedCreatorId === creator.id ? ' is-selected' : ''}`} key={creator.id} data-creator-open-id={creator.id} aria-pressed={selectedCreatorId === creator.id} onClick={(event) => onOpen(creator, event.currentTarget)}><strong>{accountName(creator, platformFilter)}</strong>{account && <><small>{platformLabel(account.platform)} · {account.externalAccountId}</small><CommerceTypeBadges account={account} /></>}<span>{creator.category ?? '未分类'}</span><div className="tag-list">{creator.tags.slice(0, 2).map((tag) => <span className="tag-chip" key={tag}>{tag}</span>)}</div>{publicPool && <small>待认领</small>}</button>;
        }) : <p className="kanban-empty">暂无达人</p>}</div>
      </section>;
    })}
  </div>;
}

function CommerceTypeChoices({ value, onChange, idPrefix }: { value: CreatorCommerceType[]; onChange: (value: CreatorCommerceType[]) => void; idPrefix: string }) {
  const options: CreatorCommerceType[] = ['short_video', 'live'];
  const toggle = (type: CreatorCommerceType, checked: boolean) => {
    onChange(checked ? [...new Set([...value, type])] : value.filter((item) => item !== type));
  };
  return <fieldset className="creator-commerce-choice-group">
    <legend>账号带货类型</legend>
    <div className="creator-commerce-choice-options">
      {options.map((type) => {
        const id = `${idPrefix}-${type}`;
        return <div className="creator-commerce-choice" key={type}>
          <Checkbox id={id} checked={value.includes(type)} onCheckedChange={(checked) => toggle(type, checked === true)} />
          <label htmlFor={id}>{commerceTypeLabels[type]}</label>
        </div>;
      })}
    </div>
    <small>可同时选择两种；暂不确定时留空，档案会标记为“未设置”。</small>
  </fieldset>;
}

function CreateCreatorDialog({ open, onOpenChange, onCloseAutoFocus, onCreated, canMakePublic, defaultPlatform }: { open: boolean; onOpenChange: (open: boolean, created?: boolean) => void; onCloseAutoFocus: (event: Event) => void; onCreated: (makePublic: boolean, platform: Platform) => void; canMakePublic: boolean; defaultPlatform: CreatorPlatformFilter }) {
  const { run, running } = useWorkbench();
  const [error, setError] = useState('');
  const [commerceTypes, setCommerceTypes] = useState<CreatorCommerceType[]>([]);
  const [selectedPlatform, setSelectedPlatform] = useState<Platform | ''>(defaultPlatform === 'all' ? '' : defaultPlatform);
  useEffect(() => {
    if (open) setSelectedPlatform(defaultPlatform === 'all' ? '' : defaultPlatform);
  }, [open, defaultPlatform]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const platformValue = String(form.get('platform') ?? '');
    if (!isPlatform(platformValue)) { setError('请选择平台。'); return; }
    const tags = String(form.get('tags') ?? '').split(/[，,]/).map((value) => value.trim()).filter(Boolean);
    try {
      const contactFields = { contactName: String(form.get('contactName') ?? '').trim() || null, phone: String(form.get('phone') ?? '').trim() || null, handle: String(form.get('handle') ?? '').trim() || null, email: String(form.get('email') ?? '').trim() || null };
      const contact = Object.values(contactFields).some(Boolean) ? contactFields : undefined;
      const shouldMakePublic = canMakePublic;
      await run({ type: 'creator.create', name: String(form.get('name') ?? ''), platform: platformValue, externalAccountId: String(form.get('externalAccountId') ?? ''), displayName: String(form.get('displayName') ?? ''), profileUrl: String(form.get('profileUrl') ?? '') || null, commerceTypes, category: String(form.get('category') ?? '') || null, tags, source: String(form.get('source') ?? '手工录入'), contact, internalNote: String(form.get('internalNote') ?? '') || null, makePublic: shouldMakePublic });
      toast.success(shouldMakePublic ? '达人已加入公海' : '达人档案已创建'); onOpenChange(false, true); formElement.reset(); setCommerceTypes([]); onCreated(shouldMakePublic, platformValue);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败，请重试。'); }
  }
  return <Modal open={open} onOpenChange={onOpenChange} onCloseAutoFocus={onCloseAutoFocus} title="新建达人" description="先填写达人名称和平台账号，再补充联系信息。" className="modal-standard modal-wide creator-create-dialog">
    <form className="modal-form creator-create-form" onSubmit={submit} onInvalid={(event) => {
      const field = event.target;
      if (field instanceof HTMLElement) {
        const details = field.closest('details:not([open])');
        if (details instanceof HTMLDetailsElement) details.open = true;
      }
    }}>
      <div className="creator-create-form-body">
        <section className="detail-section creator-create-section">
          <div className="timeline-title-row"><h3>达人和账号</h3></div>
          <div className="form-grid">
            <FormField label="达人名称" required><Input name="name" required placeholder="例如：达人姓名或机构名称" /></FormField>
            <FormField label="所属平台" required><select className="native-select" name="platform" value={selectedPlatform} onChange={(event) => { const value = event.target.value; if (isPlatform(value)) setSelectedPlatform(value); }} required><option value="" disabled>选择平台</option>{creatorPlatformOptions.filter((option) => option.value !== 'all').map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></FormField>
            <FormField label="平台账号昵称" required><Input name="displayName" required placeholder="填写平台展示的昵称" /></FormField>
            <FormField label="平台账号 ID" required hint="从团队已有的平台导出资料或订单字段复制完整编号，并与后续导入保持一致；昵称和主页链接另填。"><Input name="externalAccountId" required placeholder="粘贴平台提供的账号编号" /></FormField>
          </div>
          <CommerceTypeChoices value={commerceTypes} onChange={setCommerceTypes} idPrefix="new-creator-commerce" />
        </section>
        <details className="creator-create-more">
          <summary><span>更多信息（选填）</span><small>类目、主页、标签和联系信息</small></summary>
          <div className="form-grid creator-create-more-content">
            <FormField label="类目"><Input name="category" placeholder="例如：美妆、食品" /></FormField>
            <FormField label="主页链接"><Input name="profileUrl" type="url" placeholder="https://" /></FormField>
            <FormField label="来源"><Input name="source" defaultValue="手工录入" /></FormField>
            <FormField label="标签"><Input name="tags" placeholder="多个标签用逗号分隔" /></FormField>
            <FormField label="联系人姓名"><Input name="contactName" placeholder="可选" /></FormField>
            <FormField label="电话"><Input name="phone" type="tel" inputMode="tel" placeholder="可选" /></FormField>
            <FormField label="微信号"><Input name="handle" placeholder="可选" /></FormField>
            <FormField label="邮箱"><Input name="email" type="email" placeholder="可选" /></FormField>
            <FormField label="内部备注" className="span-2"><Textarea name="internalNote" rows={3} placeholder="只填写业务必要信息" /></FormField>
          </div>
        </details>
        {canMakePublic && <p className="detail-note">创建后进入公海，可再分配负责人。</p>}
        {error && <p className="field-error" role="alert">{error}</p>}
      </div>
      <div className="modal-actions creator-create-footer"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running} aria-busy={running}>{running ? '保存中…' : '创建达人'}</Button></div>
    </form>
  </Modal>;
}

function CreatorDetail({ creator, open, onOpenChange, onCloseFocus, presentation: requestedPresentation, publicPool, selectedPlatform, brandId }: { creator: Creator | null; open: boolean; onOpenChange: (open: boolean) => void; onCloseFocus: () => void; presentation: 'inline' | 'sheet'; publicPool: boolean; selectedPlatform: CreatorPlatformFilter; brandId: string | null }) {
  const { workspace, session, run, running } = useWorkbench();
  const [followupOpen, setFollowupOpen] = useState(false);
  const [stageOpen, setStageOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [commerceTypeTarget, setCommerceTypeTarget] = useState<CreatorAccount | null>(null);
  const [presentation, setPresentation] = useState(requestedPresentation);
  const [hasDescendantDialog, setHasDescendantDialog] = useState(false);
  const hasNestedDialog = hasDescendantDialog || followupOpen || stageOpen || transferOpen || editOpen || accountOpen || Boolean(commerceTypeTarget);
  useEffect(() => {
    // Mounting a new modal Sheet above an open child Dialog steals its focus layer.
    if (!hasNestedDialog) setPresentation(requestedPresentation);
  }, [requestedPresentation, hasNestedDialog]);
  const inlineRef = useRef<HTMLElement | null>(null);
  const inlineTitleRef = useRef<HTMLHeadingElement | null>(null);
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogTriggerRefs = useRef<Record<'followup' | 'stage' | 'edit' | 'commerce', HTMLElement | null>>({ followup: null, stage: null, edit: null, commerce: null });
  const [inlineHeight, setInlineHeight] = useState<number>();
  useEffect(() => {
    if (presentation !== 'inline' || !open || !creator) return;
    const pane = inlineRef.current;
    if (!pane) return;
    const scrollContainer = pane.closest<HTMLElement>('.app-main');
    const pageRoot = pane.closest<HTMLElement>('.creator-reference-page');
    const updateHeight = () => {
      const bottom = scrollContainer?.getBoundingClientRect().bottom ?? window.innerHeight;
      const nextHeight = Math.max(360, Math.min(900, Math.floor(bottom - pane.getBoundingClientRect().top - 14)));
      setInlineHeight((current) => current === nextHeight ? current : nextHeight);
    };
    const observer = new ResizeObserver(updateHeight);
    if (pageRoot) observer.observe(pageRoot);
    if (scrollContainer) observer.observe(scrollContainer);
    scrollContainer?.addEventListener('scroll', updateHeight, { passive: true });
    window.addEventListener('resize', updateHeight);
    updateHeight();
    const focusFrame = window.requestAnimationFrame(() => inlineTitleRef.current?.focus({ preventScroll: true }));
    return () => {
      window.cancelAnimationFrame(focusFrame);
      observer.disconnect();
      scrollContainer?.removeEventListener('scroll', updateHeight);
      window.removeEventListener('resize', updateHeight);
    };
  }, [presentation, open, creator?.id]);
  useEffect(() => {
    if (presentation !== 'inline' || !open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      if (followupOpen || stageOpen || transferOpen || editOpen || accountOpen || commerceTypeTarget) return;
      if (document.querySelector('[role="menu"][data-state="open"], [role="listbox"][data-state="open"], [role="dialog"]')) return;
      event.preventDefault();
      onOpenChange(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [presentation, open, followupOpen, stageOpen, transferOpen, editOpen, accountOpen, commerceTypeTarget, onOpenChange]);
  if (!creator) return null;
  const current = creator;
  const account = accountForPlatform(current.accounts, selectedPlatform);
  const candidateSampleAccounts = accountsForPlatform(current.accounts, selectedPlatform).filter((item) => item.active);
  const sampleAccount = candidateSampleAccounts.length === 1 ? candidateSampleAccounts[0] : undefined;
  const owner = workspace.members.find((member) => member.id === current.ownerMemberId);
  const events = buildCreatorTimeline(current, workspace);
  const canClaim = publicPool && !current.ownerMemberId && session.actor.role === 'bd';
  const canTransfer = session.actor.role === 'manager' || session.actor.role === 'admin';
  const canManageSharedProfiles = !session.businessWorkspace || session.canManageBrands === true;
  const canEditAccountTypes = canTransfer && canManageSharedProfiles;
  const canEdit = current.ownerMemberId === session.actor.memberId || session.actor.role === 'manager' || session.actor.role === 'admin';
  const canUseMoreActions = canTransfer || (canEdit && (!current.profileId || (canTransfer && canManageSharedProfiles)));
  const restoreMoreFocus = (event: Event) => {
    event.preventDefault();
    const target = moreTriggerRef.current ?? inlineTitleRef.current;
    if (target) target.focus({ preventScroll: true });
    else onCloseFocus();
  };
  const restoreDetailDialogFocus = (key: keyof typeof dialogTriggerRefs.current) => (event: Event) => {
    const trigger = dialogTriggerRefs.current[key];
    focusAfterDialogClose(event, trigger, () => inlineTitleRef.current);
  };
  const setDetailDialogOpen = (key: keyof typeof dialogTriggerRefs.current, setter: (open: boolean) => void, nextOpen: boolean) => {
    setter(nextOpen);
    if (!nextOpen) scheduleFocusAfterLayout(dialogTriggerRefs.current[key], () => inlineTitleRef.current);
  };
  async function claim() {
    try { await run({ type: 'creator.claim', creatorId: current.id, expectedVersion: current.version }); toast.success('已认领到我的达人'); onOpenChange(false); }
    catch (cause) { toast.error(cause instanceof Error ? cause.message : '认领失败'); }
  }
  const header = presentation === 'inline'
    ? <header className="creator-drawer-header creator-inline-detail-header">
      <div className="creator-inline-detail-topline"><div className="drawer-kicker">达人档案 <span>·</span> {account ? platformLabel(account.platform) : '平台账号待登记'}</div><Button variant="ghost" size="icon" className="creator-inline-detail-close" aria-label="关闭达人详情" onClick={() => onOpenChange(false)}><X size={16} /></Button></div>
      <h2 ref={inlineTitleRef} tabIndex={-1} className="creator-inline-detail-title" id="creator-inline-detail-title">{accountName(current, selectedPlatform)}</h2>
      <p className="creator-inline-detail-description">{current.name}{account ? ` · ${platformLabel(account.platform)}账号 ID ${account.externalAccountId}` : ''}</p>
      <div className="drawer-header-meta"><StatusPill value={current.crmStage} label={stageLabels[current.crmStage]} />{owner ? <span>负责人：{owner.displayName}</span> : <span className="text-muted">公海待认领</span>}</div>
    </header>
    : <SheetHeader className="creator-drawer-header">
      <div className="drawer-kicker">达人档案 <span>·</span> {account ? platformLabel(account.platform) : '平台账号待登记'}</div>
      <SheetTitle ref={inlineTitleRef} tabIndex={-1}>{accountName(current, selectedPlatform)}</SheetTitle>
      <SheetDescription>{current.name}{account ? ` · ${platformLabel(account.platform)}账号 ID ${account.externalAccountId}` : ''}</SheetDescription>
      <div className="drawer-header-meta"><StatusPill value={current.crmStage} label={stageLabels[current.crmStage]} />{owner ? <span>负责人：{owner.displayName}</span> : <span className="text-muted">公海待认领</span>}</div>
    </SheetHeader>;
  const actions = <div className="creator-drawer-actions">
    {canEdit && <Button onClick={(event) => { dialogTriggerRefs.current.followup = event.currentTarget; setFollowupOpen(true); }}><MessageSquarePlus size={15} />记录跟进</Button>}
    {canClaim && <Button onClick={() => void claim()} disabled={running} aria-busy={running}><UserRoundCheck size={15} />认领达人</Button>}
    {canEdit && <Button variant="outline" onClick={(event) => { dialogTriggerRefs.current.edit = event.currentTarget; setEditOpen(true); }}>编辑资料</Button>}
    {canEdit && <Button variant="outline" onClick={(event) => { dialogTriggerRefs.current.stage = event.currentTarget; setStageOpen(true); }}>调整阶段</Button>}
    {canEdit && sampleAccount && <Link className="button button-outline" to={creatorScopedHref('/samples', { creatorId: current.id, accountId: sampleAccount.id, platform: sampleAccount.platform }, brandId)}>申请寄样</Link>}
    {canEdit && candidateSampleAccounts.length > 1 && <span className="creator-sample-account-hint">请从下方具体账号进入寄样申请。</span>}
    {canUseMoreActions && <DropdownMenu>
      <DropdownMenuTrigger asChild><Button ref={moreTriggerRef} variant="outline" className="creator-detail-more" aria-label="更多达人操作"><MoreHorizontal size={16} />更多</Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {canEdit && (!current.profileId || (canTransfer && canManageSharedProfiles)) && <DropdownMenuItem onSelect={() => setAccountOpen(true)}>添加或核对账号</DropdownMenuItem>}
        {canTransfer && canEdit && (!current.profileId || canManageSharedProfiles) && <DropdownMenuSeparator />}
        {canTransfer && <DropdownMenuItem onSelect={() => setTransferOpen(true)}><UserRoundCheck size={15} />{current.ownerMemberId ? '转交负责人' : '分配商务'}</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>}
  </div>;
  const detailBody = <div className="creator-detail-scroll">
          <section className="detail-section"><h3>基本资料</h3><div className="detail-grid"><Detail label="类目" value={current.category ?? '未分类'} /><Detail label="来源" value={sourceLabel(current.source)} /><Detail label="负责人" value={owner?.displayName ?? '公海'} /><Detail label="最近更新" value={formatDateTime(current.updatedAt)} /></div><div className="detail-tags">{current.tags.length ? current.tags.map((tag) => <span className="tag-chip" key={tag}>{tag}</span>) : <span className="text-muted">暂无标签</span>}</div></section>
          <section className="detail-section"><div className="timeline-title-row"><h3>平台账号</h3><span>{current.accounts.length} 个</span></div><div className="account-list">{current.accounts.map((creatorAccount) => <div className="account-row" key={creatorAccount.id}><div><strong>{creatorAccount.displayName}</strong><small><StatusPill value={creatorAccount.platform} label={platformLabel(creatorAccount.platform)} tone="blue" /> ID {creatorAccount.externalAccountId} · {creatorAccount.active ? '使用中' : '已停用'}</small><CommerceTypeBadges account={creatorAccount} /></div><span>{creatorAccount.profileUrl ? <a href={creatorAccount.profileUrl} target="_blank" rel="noreferrer">打开主页 <ExternalLink size={11} /></a> : null}{creatorAccount.active && canEdit && <Link className="button button-outline creator-account-sample-link" to={creatorScopedHref('/samples', { creatorId: current.id, accountId: creatorAccount.id, platform: creatorAccount.platform }, brandId)}>申请寄样</Link>}{canEditAccountTypes && <Button size="sm" variant="ghost" onClick={(event) => { dialogTriggerRefs.current.commerce = event.currentTarget; setCommerceTypeTarget(creatorAccount); }}>修改带货类型</Button>}</span></div>)}</div></section>
          {current.contact && <section className="detail-section"><h3>业务联系信息</h3><div className="detail-grid"><Detail label="联系人" value={current.contact.contactName ?? '—'} /><Detail label="电话" value={current.contact.phone ?? '—'} /><Detail label="微信号" value={current.contact.handle ?? '—'} /><Detail label="邮箱" value={current.contact.email ?? '—'} /></div></section>}
          {!current.contact && canEdit && <section className="detail-section"><h3>业务联系信息</h3><p className="detail-note">尚未记录联系人、微信、电话或邮箱。</p></section>}
          <CreatorSessionHistory creatorId={current.id} accounts={current.accounts} canEdit={canEdit} platform={selectedPlatform} />
          {current.internalNote && <section className="detail-section"><h3>内部备注</h3><p className="detail-note">{current.internalNote}</p></section>}
          <details className="creator-history-details">
            <summary>合作、排期与订单记录</summary>
            <div className="creator-history-details-body">
              {canEdit && <div className="creator-history-detail-actions"><Link className="button button-outline" to={creatorScopedHref('/schedule', { creatorId: current.id }, brandId)}>准备排期</Link></div>}
              <CreatorPerformance creatorId={current.id} brandId={brandId} />
              <CreatorCooperationPanel creatorId={current.id} />
            </div>
          </details>
          <section className="detail-section timeline-section"><div className="timeline-title-row"><h3>业务时间线</h3><span>{events.length} 条记录</span></div>{events.length ? <ol className="timeline-list">{events.map((event) => <li key={event.id} className={`timeline-item timeline-${event.kind}`}><span className="timeline-marker" /><div><div className="timeline-event-title">{event.title}</div><div className="timeline-event-detail">{event.detail}</div><time>{formatDateTime(event.at)}</time></div></li>)}</ol> : <EmptyState title="还没有业务记录" description="记录第一次建联后，这里会显示跟进、寄样和合作进展。" action={canEdit && <Button size="sm" variant="outline" onClick={(event) => { dialogTriggerRefs.current.followup = event.currentTarget; setFollowupOpen(true); }}>记录第一次跟进</Button>} />}</section>
        </div>;
  return <ModalActivityBoundary onActiveChange={setHasDescendantDialog}>
    {presentation === 'inline'
      ? <aside ref={inlineRef} className="creator-drawer creator-inline-detail" style={{ height: inlineHeight }} aria-labelledby="creator-inline-detail-title" aria-label={`${accountName(current, selectedPlatform)}达人档案`}>{header}{actions}{detailBody}</aside>
      : <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="creator-drawer" onCloseAutoFocus={(event) => { event.preventDefault(); onCloseFocus(); }}>{header}{actions}{detailBody}</SheetContent>
      </Sheet>}
    <FollowupDialog creator={current} account={account} open={followupOpen} onOpenChange={(nextOpen) => setDetailDialogOpen('followup', setFollowupOpen, nextOpen)} onCloseAutoFocus={restoreDetailDialogFocus('followup')} />
    <StageDialog creator={current} open={stageOpen} onOpenChange={(nextOpen) => setDetailDialogOpen('stage', setStageOpen, nextOpen)} onCloseAutoFocus={restoreDetailDialogFocus('stage')} />
    {transferOpen && <TransferCreatorDialog creator={current} open onOpenChange={(open) => setTransferOpen(open)} onTransferred={() => onOpenChange(false)} onCloseAutoFocus={restoreMoreFocus} />}
    {editOpen && <EditCreatorDialog creator={current} open onOpenChange={(nextOpen) => setDetailDialogOpen('edit', setEditOpen, nextOpen)} onCloseAutoFocus={restoreDetailDialogFocus('edit')} />}
    {accountOpen && <CreatorAccountDialog creator={current} open onOpenChange={(open) => setAccountOpen(open)} onCloseAutoFocus={restoreMoreFocus} />}
    {commerceTypeTarget && <CreatorAccountCommerceDialog creator={current} account={commerceTypeTarget} open onOpenChange={(nextOpen) => { if (!nextOpen) { scheduleFocusAfterLayout(dialogTriggerRefs.current.commerce, () => inlineTitleRef.current); setCommerceTypeTarget(null); } }} onCloseAutoFocus={restoreDetailDialogFocus('commerce')} />}
  </ModalActivityBoundary>;
}

function CreatorPerformance({ creatorId, brandId }: { creatorId: string; brandId: string | null }) {
  const { workspace } = useWorkbench();
  const [dateFrom, setDateFrom] = useState(() => `${shanghaiDateKey(new Date()).slice(0, 7)}-01`);
  const [dateTo, setDateTo] = useState(() => shanghaiDateKey(new Date()));
  const identity = useMemo(() => creatorIdentityGroup(creatorId, workspace.creators), [creatorId, workspace.creators]);
  const orderAttribution = useMemo(() => creatorOrderAttribution(creatorId, workspace.creators, workspace.orders), [creatorId, workspace.creators, workspace.orders]);
  const isInRange = (value: string | null | undefined) => {
    if (!value) return false;
    const key = shanghaiDateKey(value);
    return Boolean(key) && (!dateFrom || key >= dateFrom) && (!dateTo || key <= dateTo);
  };
  const cooperations = useMemo(() => workspace.cooperations.filter((item) => identity.creatorIds.has(item.creatorId) && isInRange(item.startAt ?? item.createdAt)).sort((a, b) => compareTimestamps(a.startAt ?? a.createdAt, b.startAt ?? b.createdAt, 'desc')), [workspace.cooperations, identity.creatorIds, dateFrom, dateTo]);
  const schedules = useMemo(() => workspace.schedules.filter((item) => identity.creatorIds.has(item.creatorId) && isInRange(item.plannedStartAt)).sort((a, b) => compareTimestamps(a.plannedStartAt, b.plannedStartAt, 'desc')), [workspace.schedules, identity.creatorIds, dateFrom, dateTo]);
  const deliveries = useMemo(() => workspace.deliveries.filter((item) => identity.creatorIds.has(item.creatorId) && isInRange(item.dueAt)), [workspace.deliveries, identity.creatorIds, dateFrom, dateTo]);
  const paidOrders = useMemo(() => orderAttribution.orders.filter((order) => order.status === 'paid' && isInRange(order.paidAt)).sort((a, b) => compareTimestamps(a.paidAt, b.paidAt, 'desc')), [orderAttribution.orders, dateFrom, dateTo]);
  const paidAmountCents = paidOrders.reduce((sum, order) => sum + (order.paidAmountCents ?? 0), 0);
  const unknownPaidCount = paidOrders.filter((order) => order.paidAmountCents === null).length;
  const creatorOrderIds = new Set(orderAttribution.orders.map((order) => order.id));
  const refundStatus = workspace.metrics.dataCoverage.refundDataStatus;
  const periodRefunds = workspace.refunds.filter((refund) => creatorOrderIds.has(refund.orderLineId) && isInRange(refund.refundedAt));
  const succeededRefunds = periodRefunds.filter((refund) => refund.status === 'succeeded');
  const refundAmountCents = succeededRefunds.reduce((sum, refund) => {
    if (refund.amountCents === null) return sum;
    return sum + (refund.direction === 'refund' ? refund.amountCents : -refund.amountCents);
  }, 0);
  const unknownRefundCount = succeededRefunds.filter((refund) => refund.amountCents === null).length;
  const recentCooperations = cooperations.slice(0, 3);
  const recentSchedules = schedules.slice(0, 3);
  const deliveredCount = cooperations.filter((item) => item.status === 'delivered').length;
  const approvedDeliveries = deliveries.filter((item) => item.status === 'approved').length;
  const refundStatusCopy = refundStatus === 'not_visible'
    ? '退款记录暂不可查看。'
    : refundStatus === 'not_imported'
      ? '暂无退款数据，金额待核对。'
      : '已记录';
  const ordersParams: Record<string, string> = { creatorId };
  if (dateFrom) ordersParams.dateFrom = dateFrom;
  if (dateTo) ordersParams.dateTo = dateTo;
  const ordersHref = creatorScopedHref('/orders', ordersParams, brandId);

  return <section className="detail-section creator-performance" aria-labelledby="creator-performance-title">
    <div className="timeline-title-row"><h3 id="creator-performance-title">合作表现</h3></div>
    <div className="creator-performance-controls"><label>统计开始<input className="filter-input" type="date" value={dateFrom} max={dateTo || undefined} onChange={(event) => setDateFrom(event.target.value)} aria-label="合作表现统计开始日期" /></label><span aria-hidden="true">至</span><label>统计结束<input className="filter-input" type="date" value={dateTo} min={dateFrom || undefined} onChange={(event) => setDateTo(event.target.value)} aria-label="合作表现统计结束日期" /></label><button className="link-button" type="button" onClick={() => { setDateFrom(''); setDateTo(''); }}>全部日期</button></div>
    <div className="creator-performance-grid" aria-label="所选日期范围内的合作指标">
      <div className="small-metric"><span>合作单</span><strong>{cooperations.length}</strong><small>已交付 {deliveredCount} 单</small></div>
      <div className="small-metric"><span>直播排期</span><strong>{schedules.length}</strong><small>已完成 {schedules.filter((item) => item.status === 'completed').length} 场</small></div>
      <div className="small-metric"><span>交付验收</span><strong>{approvedDeliveries}/{deliveries.length}</strong><small>按交付截止日统计</small></div>
      <div className="small-metric"><span>订单支付金额</span><strong>{paidOrders.length ? formatMoney(paidAmountCents) : '—'}</strong><small>{paidOrders.length} 条已支付订单{unknownPaidCount ? ` · ${unknownPaidCount} 条金额未知` : ''}</small></div>
      <div className="small-metric"><span>退款记录</span><strong>{refundStatus === 'records_only' ? `${periodRefunds.length} 条` : refundStatus === 'not_visible' ? '暂不可查看' : '待核对'}</strong><small>{refundStatus === 'records_only' ? `${refundStatusCopy}：${formatMoney(refundAmountCents)}${unknownRefundCount ? ` · ${unknownRefundCount} 条金额未知` : ''}` : refundStatusCopy}</small></div>
    </div>
    <div className="creator-performance-links"><Link className="panel-inline-link" to={ordersHref}>查看此达人订单明细 <span>→</span></Link></div>
    <div className="creator-performance-lists">
      <div><div className="timeline-title-row"><h4>最近合作</h4><span>{cooperations.length} 单</span></div>{recentCooperations.length ? <ol className="creator-recent-list">{recentCooperations.map((item) => <li key={item.id}><Link to={creatorScopedHref('/cooperations', { cooperationId: item.id }, brandId)}>{item.title}</Link><span>{statusLabel(item.status)} · {formatDate(item.startAt ?? item.createdAt)}</span></li>)}</ol> : <p className="detail-note">所选日期范围没有合作单。</p>}</div>
      <div><div className="timeline-title-row"><h4><CalendarClock size={13} />最近场次</h4><span>{schedules.length} 场</span></div>{recentSchedules.length ? <ol className="creator-recent-list">{recentSchedules.map((item) => <li key={item.id}><Link to={creatorScopedHref('/schedule', { scheduleId: item.id }, brandId)}>{item.title}</Link><span>{statusLabel(item.status)} · {formatDateTime(item.plannedStartAt)}</span></li>)}</ol> : <p className="detail-note">所选日期范围没有直播场次。</p>}</div>
    </div>
  </section>;
}

function TransferCreatorDialog({ creator, open, onOpenChange, onTransferred, onCloseAutoFocus }: { creator: Creator; open: boolean; onOpenChange: (open: boolean) => void; onTransferred: () => void; onCloseAutoFocus?: (event: Event) => void }) {
  const { workspace, run, running } = useWorkbench();
  const [error, setError] = useState('');
  const members = workspace.members.filter((member) => member.active);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); const formElement = event.currentTarget; const form = new FormData(formElement);
    try {
      await run({ type: 'creator.transfer', creatorId: creator.id, targetMemberId: String(form.get('targetMemberId') ?? ''), expectedVersion: creator.version, effectiveAt: shanghaiInputToIso(String(form.get('effectiveAt') ?? '')), reason: String(form.get('reason') ?? '') });
      toast.success('达人负责人已更新'); onOpenChange(false); onTransferred();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '转交失败'); }
  }
  return <Modal open={open} onOpenChange={onOpenChange} onCloseAutoFocus={onCloseAutoFocus} title={creator.ownerMemberId ? '转交达人负责人' : '分配达人给商务'} description="原负责人负责期间的业绩仍归原负责人。">
    <form className="modal-form" onSubmit={submit}><FormField label="接手商务" required><select className="native-select" name="targetMemberId" required><option value="">选择在职成员</option>{members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select></FormField><FormField label="生效时间" required><Input type="datetime-local" name="effectiveAt" defaultValue={shanghaiDateTimeInput()} required /></FormField><FormField label="分配 / 转交原因" required><Textarea name="reason" rows={3} required placeholder="例如：新达人分配、成员转岗或业务交接" /></FormField>{error && <p className="field-error" role="alert">{error}</p>}<div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running || members.length === 0} aria-busy={running}>{running ? '保存中…' : '确认分配'}</Button></div></form>
  </Modal>;
}

function Detail({ label, value }: { label: string; value: ReactNode }) {
  return <div className="detail-cell"><span>{label}</span><strong>{value}</strong></div>;
}

function EditCreatorDialog({ creator, open, onOpenChange, onCloseAutoFocus }: { creator: Creator; open: boolean; onOpenChange: (open: boolean) => void; onCloseAutoFocus: (event: Event) => void }) {
  const { run, running, session } = useWorkbench();
  const canEditShared = !creator.profileId || ((session.actor.role === 'manager' || session.actor.role === 'admin')
    && (!session.businessWorkspace || session.canManageBrands === true));
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); const form = new FormData(event.currentTarget);
    const tags = String(form.get('tags') ?? '').split(/[，,]/).map((value) => value.trim()).filter(Boolean);
    const contact = {
      contactName: String(form.get('contactName') ?? '').trim() || null,
      phone: String(form.get('phone') ?? '').trim() || null,
      handle: String(form.get('handle') ?? '').trim() || null,
      email: String(form.get('email') ?? '').trim() || null,
    };
    try {
      await run({ type: 'creator.update', creatorId: creator.id, expectedVersion: creator.version, expectedProfileVersion: creator.profileVersion, expectedContactVersion: creator.contactVersion, ...(canEditShared ? { name: String(form.get('name') ?? ''), category: String(form.get('category') ?? '') || null, tags } : {}), contact, internalNote: String(form.get('internalNote') ?? '') || null });
      toast.success('达人资料已更新'); onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败，请重试。'); }
  }
  return <Modal open={open} onOpenChange={onOpenChange} onCloseAutoFocus={onCloseAutoFocus} title="编辑达人资料" description={!canEditShared ? "名称、类目和标签由管理员维护。你可以修改当前品牌的联系信息和备注。" : "修改达人资料和联系信息；留空会清除对应联系信息。"} className="modal-standard modal-wide">
    <form className="modal-form" onSubmit={submit}><div className="form-grid"><FormField label="达人名称" required><Input name="name" required readOnly={!canEditShared} defaultValue={creator.name} /></FormField><FormField label="类目"><Input name="category" readOnly={!canEditShared} defaultValue={creator.category ?? ''} /></FormField><FormField label="标签" className="span-2"><Input name="tags" readOnly={!canEditShared} defaultValue={creator.tags.join(', ')} placeholder="多个标签用逗号分隔" /></FormField><FormField label="联系人姓名"><Input name="contactName" defaultValue={creator.contact?.contactName ?? ''} /></FormField><FormField label="电话"><Input name="phone" type="tel" inputMode="tel" defaultValue={creator.contact?.phone ?? ''} /></FormField><FormField label="微信号"><Input name="handle" defaultValue={creator.contact?.handle ?? ''} /></FormField><FormField label="邮箱"><Input name="email" type="email" defaultValue={creator.contact?.email ?? ''} /></FormField><FormField label="内部备注" className="span-2"><Textarea name="internalNote" rows={3} defaultValue={creator.internalNote ?? ''} /></FormField></div>{error && <p className="field-error" role="alert">{error}</p>}<div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running} aria-busy={running}>{running ? '保存中…' : '保存资料'}</Button></div></form>
  </Modal>;
}

function CreatorAccountDialog({ creator, open, onOpenChange, onCloseAutoFocus }: { creator: Creator; open: boolean; onOpenChange: (open: boolean) => void; onCloseAutoFocus?: (event: Event) => void }) {
  const { run, running } = useWorkbench();
  const [error, setError] = useState('');
  const [commerceTypes, setCommerceTypes] = useState<CreatorCommerceType[]>([]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); const form = new FormData(event.currentTarget);
    const platformValue = String(form.get('platform') ?? '');
    if (!isPlatform(platformValue)) { setError('请选择平台。'); return; }
    try {
      await run({ type: 'creator.addAccount', creatorId: creator.id, expectedVersion: creator.version, expectedProfileVersion: creator.profileVersion, platform: platformValue, externalAccountId: String(form.get('externalAccountId') ?? ''), displayName: String(form.get('displayName') ?? ''), profileUrl: String(form.get('profileUrl') ?? '') || null, commerceTypes });
      toast.success('平台账号已添加或核对'); onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败，请重试。'); }
  }
  return <Modal open={open} onOpenChange={onOpenChange} onCloseAutoFocus={onCloseAutoFocus} title="添加 / 核对平台账号" description="填写平台账号 ID 和昵称；同一平台账号不能重复关联。">
    <form className="modal-form" onSubmit={submit}><FormField label="所属平台" required><select className="native-select" name="platform" required defaultValue=""><option value="" disabled>选择平台</option>{creatorPlatformOptions.filter((option) => option.value !== 'all').map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></FormField><FormField label="平台账号 ID" required hint="用于区分同名账号和匹配订单；从团队已有的平台导出资料或订单字段复制完整编号。"><Input name="externalAccountId" required placeholder="粘贴平台提供的账号编号" /></FormField><FormField label="当前账号昵称" required><Input name="displayName" required placeholder="填写账号昵称" /></FormField><FormField label="主页链接"><Input name="profileUrl" type="url" placeholder="https://" /></FormField><CommerceTypeChoices value={commerceTypes} onChange={setCommerceTypes} idPrefix="added-account-commerce" />{error && <p className="field-error" role="alert">{error}</p>}<div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running} aria-busy={running}>{running ? '保存中…' : '保存账号'}</Button></div></form>
  </Modal>;
}

function CreatorAccountCommerceDialog({ creator, account, open, onOpenChange, onCloseAutoFocus }: { creator: Creator; account: CreatorAccount; open: boolean; onOpenChange: (open: boolean) => void; onCloseAutoFocus: (event: Event) => void }) {
  const { run, running } = useWorkbench();
  const [error, setError] = useState('');
  const [commerceTypes, setCommerceTypes] = useState<CreatorCommerceType[]>(account.commerceTypes ?? []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    try {
      await run({ type: 'creator.updateAccount', creatorId: creator.id, accountId: account.id, expectedVersion: creator.version, expectedProfileVersion: creator.profileVersion ?? 1, expectedAccountVersion: account.accountVersion ?? 1, commerceTypes });
      toast.success('账号带货类型已更新'); onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败，请重试。'); }
  }
  return <Modal open={open} onOpenChange={onOpenChange} onCloseAutoFocus={onCloseAutoFocus} title="修改账号带货类型" description={`${platformLabel(account.platform)}账号 ${account.displayName}。类型按这个平台账号维护。`}>
    <form className="modal-form" onSubmit={submit}><CommerceTypeChoices value={commerceTypes} onChange={setCommerceTypes} idPrefix={`edit-account-${account.id}`} />{error && <p className="field-error" role="alert">{error}</p>}<div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running} aria-busy={running}>{running ? '保存中…' : '保存类型'}</Button></div></form>
  </Modal>;
}

function buildCreatorTimeline(creator: Creator, workspace: ReturnType<typeof useWorkbench>['workspace']) {
  const items: Array<{ id: string; kind: string; title: string; detail: string; at: string }> = [];
  for (const followup of workspace.followups.filter((item) => item.creatorId === creator.id)) items.push({ id: `followup-${followup.id}`, kind: 'followup', title: `跟进 · ${resultLabels[followup.result]}`, detail: `${channelLabels[followup.channel]} · ${followup.summary}`, at: followup.occurredAt });
  for (const assignment of workspace.ownerAssignments.filter((item) => item.creatorId === creator.id)) {
    const member = workspace.members.find((item) => item.id === assignment.memberId);
    items.push({ id: `assignment-${assignment.id}`, kind: 'assignment', title: member ? `负责人变更 · ${member.displayName}` : '达人转入公海', detail: assignment.reason, at: assignment.validFrom });
  }
  for (const sample of workspace.samples.filter((item) => item.creatorId === creator.id)) items.push({ id: `sample-${sample.id}`, kind: 'sample', title: `样品申请 · ${statusLabel(sample.status)}`, detail: `${sample.lines.length} 个商品行 · ${sample.reason}`, at: sample.createdAt });
  for (const cooperation of workspace.cooperations.filter((item) => item.creatorId === creator.id)) items.push({ id: `cooperation-${cooperation.id}`, kind: 'cooperation', title: `合作 · ${cooperation.title}`, detail: `${cooperation.lines.length} 个商品 · ${statusLabel(cooperation.status)}`, at: cooperation.createdAt });
  for (const schedule of workspace.schedules.filter((item) => item.creatorId === creator.id)) items.push({ id: `schedule-${schedule.id}`, kind: 'schedule', title: `排期 · ${schedule.title}`, detail: `${statusLabel(schedule.status)} · ${formatDateTime(schedule.plannedStartAt)}`, at: schedule.updatedAt });
  for (const delivery of workspace.deliveries.filter((item) => item.creatorId === creator.id)) items.push({ id: `delivery-${delivery.id}`, kind: 'delivery', title: `交付 · ${delivery.title}`, detail: `${statusLabel(delivery.status)} · 截止 ${formatDateTime(delivery.dueAt)}`, at: delivery.updatedAt });
  return items.sort((a, b) => compareTimestamps(a.at, b.at, 'desc'));
}

function FollowupDialog({ creator, account, open, onOpenChange, onCloseAutoFocus }: { creator: Creator; account: Creator['accounts'][number] | undefined; open: boolean; onOpenChange: (open: boolean) => void; onCloseAutoFocus: (event: Event) => void }) {
  const { run, running } = useWorkbench();
  const [includeTask, setIncludeTask] = useState(true);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const dueAt = String(form.get('dueAt') ?? '');
    const nextAction = includeTask && dueAt ? { title: String(form.get('taskTitle') ?? '').trim() || '继续跟进达人', dueAt: shanghaiInputToIso(dueAt), priority: String(form.get('priority') ?? 'normal') as 'low' | 'normal' | 'high' } : null;
    try {
      await run({ type: 'followup.add', creatorId: creator.id, expectedCreatorVersion: creator.version, occurredAt: shanghaiInputToIso(String(form.get('occurredAt') ?? '')), channel: String(form.get('channel') ?? 'wechat') as FollowupChannel, result: String(form.get('result') ?? 'contacted') as FollowupResult, summary: String(form.get('summary') ?? ''), accountId: account?.id ?? null, evidenceUrl: String(form.get('evidenceUrl') ?? '') || null, nextAction });
      toast.success('跟进记录已保存'); onOpenChange(false); formElement.reset();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败，请重试。'); }
  }
  return <Modal open={open} onOpenChange={onOpenChange} onCloseAutoFocus={onCloseAutoFocus} title="记录跟进" description={`为 ${account ? `${platformLabel(account.platform)}账号 ${account.displayName}` : creator.name} 添加一条有时间、有结果的沟通记录。`}>
    <form className="modal-form" onSubmit={submit}>
      <div className="form-grid">
        <FormField label="发生时间" required><Input type="datetime-local" name="occurredAt" defaultValue={shanghaiDateTimeInput()} required /></FormField>
        <FormField label="沟通方式" required><select name="channel" className="native-select" defaultValue="wechat">{Object.entries(channelLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></FormField>
        <FormField label="沟通结果" required><select name="result" className="native-select" defaultValue="contacted">{Object.entries(resultLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></FormField>
        <FormField label="跟进证据链接"><Input type="url" name="evidenceUrl" placeholder="https://" /></FormField>
        <FormField label="沟通摘要" required className="span-2"><Textarea name="summary" rows={3} required maxLength={4000} placeholder="记录对方反馈、合作条件或需要核实的信息" /></FormField>
      </div>
      <label className="check-row"><input type="checkbox" checked={includeTask} onChange={(event) => setIncludeTask(event.target.checked)} />同时创建下一步待办</label>
      {includeTask && <div className="form-grid"><FormField label="待办标题"><Input name="taskTitle" placeholder="例如：补充寄样地址" /></FormField><FormField label="截止时间" required><Input type="datetime-local" name="dueAt" required={includeTask} defaultValue={shanghaiDateTimeInput(new Date(Date.now() + 24 * 60 * 60 * 1000))} /></FormField><FormField label="优先级"><select name="priority" className="native-select" defaultValue="normal"><option value="low">低</option><option value="normal">普通</option><option value="high">高</option></select></FormField></div>}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running} aria-busy={running}>{running ? '保存中…' : '保存跟进'}</Button></div>
    </form>
  </Modal>;
}

function StageDialog({ creator, open, onOpenChange, onCloseAutoFocus }: { creator: Creator; open: boolean; onOpenChange: (open: boolean) => void; onCloseAutoFocus: (event: Event) => void }) {
  const { run, running } = useWorkbench();
  const [stage, setStage] = useState<CrmStage>(creator.crmStage);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); const form = new FormData(event.currentTarget);
    try {
      await run({ type: 'creator.setStage', creatorId: creator.id, expectedVersion: creator.version, stage, occurredAt: shanghaiInputToIso(String(form.get('occurredAt') ?? '')), reason: String(form.get('reason') ?? '') || null, reviewAt: stage === 'paused' && String(form.get('reviewAt') ?? '') ? shanghaiInputToIso(String(form.get('reviewAt') ?? '')) : null });
      toast.success('建联阶段已更新'); onOpenChange(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '更新失败'); }
  }
  return <Modal open={open} onOpenChange={onOpenChange} onCloseAutoFocus={onCloseAutoFocus} title="调整建联阶段" description="阶段变化会记录操作人和时间。公海归属与建联阶段是独立状态。">
    <form className="modal-form" onSubmit={submit}><FormField label="新阶段" required><select value={stage} onChange={(event) => setStage(event.target.value as CrmStage)} className="native-select">{stageOrder.map((value) => <option value={value} key={value}>{stageLabels[value]}</option>)}</select></FormField><FormField label="发生时间" required><Input name="occurredAt" type="datetime-local" defaultValue={shanghaiDateTimeInput()} required /></FormField>{stage === 'paused' && <FormField label="复查时间"><Input name="reviewAt" type="datetime-local" /></FormField>}<FormField label="原因 / 补充说明"><Textarea name="reason" rows={2} maxLength={1000} placeholder="暂停、不合作或恢复时建议填写原因" /></FormField>{error && <p className="field-error" role="alert">{error}</p>}<div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={running || stage === creator.crmStage} aria-busy={running}>{running ? '保存中…' : '确认调整'}</Button></div></form>
  </Modal>;
}
