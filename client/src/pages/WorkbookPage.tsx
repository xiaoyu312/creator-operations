import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { ChevronDown, Eye, EyeOff, FileSpreadsheet, RefreshCw, Search, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import {
  WORKBOOK_BLANK_SOURCE_STATUS,
  WORKBOOK_COORDINATION_STATUSES,
  WORKBOOK_PLATFORMS,
  WORKBOOK_SENSITIVE_COLUMN_LABELS,
  type WorkbookCell,
  type WorkbookCoordinationStatus,
  type WorkbookListFilters,
  type LocalWorkbookActor,
  type WorkbookFieldState,
  type WorkbookPlatform,
  type WorkbookRecordSelector,
  type WorkbookRowDetail,
  type WorkbookRowListItem,
  type WorkbookSummary,
  type WorkbookUpdatePatch,
} from '@shared/workbook';
import { ApiError } from '../api';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { EmptyState, FormField, Modal, PageHeading, Panel, StatusPill, formatDateTime, shanghaiDateTimeInput, shanghaiInputToIso } from '../components/workbench';
import { createWorkbookRow, getWorkbookRowDetail, getWorkbookSummary, listWorkbookRows, updateWorkbookRow } from '../lib/workbook-api';
import { useWorkbench } from '../workbench-context';
import { getWorkbookContext, type WorkbookContext } from '../lib/workbook-context';
import { isUnavailableDemoBrand } from '@shared/scenario-brand';
import '../workbook.css';

const PAGE_SIZE = 50;
const coordinationLabels: Record<WorkbookCoordinationStatus, string> = {
  unreviewed: '未标记',
  in_progress: '跟进中',
  waiting: '待确认',
  resolved: '已处理',
  on_hold: '暂缓',
};

type WorkbookKind = 'samples' | 'broadcast';
type WorkbookFilters = {
  sourceSha256: string;
  platform: WorkbookPlatform | '';
  year: string;
  sheetName: string;
  businessOwner: string;
  sourceStatus: string;
  fieldState: WorkbookFieldState | '';
  coordinationStatus: WorkbookCoordinationStatus | '';
  includeHidden: boolean;
  query: string;
  page: number;
};

function isSensitiveColumn(kind: WorkbookKind, row: Pick<WorkbookRowListItem, 'sensitiveColumnKeys'>, column: WorkbookRowListItem['columns'][number]) {
  return column.sensitive || row.sensitiveColumnKeys.includes(column.key) || WORKBOOK_SENSITIVE_COLUMN_LABELS[kind].includes(column.label);
}

function canRevealSensitive(role: LocalWorkbookActor['role'], kind: WorkbookKind) {
  return role === 'local_manager' || role === 'local_bd'
    || (role === 'local_shipping' && kind === 'samples')
    || (role === 'local_links' && kind === 'broadcast');
}

function cellText(value: WorkbookCell | undefined) {
  if (value === undefined || value === null || value === '') return '—';
  return String(value);
}

function toInputValue(value: WorkbookCell | string | undefined) {
  return value === undefined || value === null ? '' : String(value);
}

function toLocalDateTime(value: string | null) {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : shanghaiDateTimeInput(parsed);
}

function sourceStatusLabel(kind: WorkbookKind) {
  return kind === 'samples' ? '历史寄样状态' : '历史上播状态';
}

function businessOwnerLabel(kind: WorkbookKind) {
  return kind === 'samples' ? '寄样商务' : '对接商务';
}

function fieldStateChoices(kind: WorkbookKind): Array<{ value: WorkbookFieldState | ''; label: string }> {
  return kind === 'samples'
    ? [{ value: '', label: '全部' }, { value: 'tracking_missing', label: '未登记单号' }, { value: 'tracking_recorded', label: '已登记单号' }]
    : [{ value: '', label: '全部' }, { value: 'link_missing', label: '未填链接' }, { value: 'link_recorded', label: '已填链接' }];
}

function rowSelector(row: WorkbookRowListItem): WorkbookRecordSelector {
  if (row.recordOrigin === 'source' && row.sourceSha256 && row.sourceRow !== null) {
    return { recordOrigin: 'source', sourceSha256: row.sourceSha256, sheetName: row.sheetName, sourceRow: row.sourceRow };
  }
  if (row.recordOrigin === 'local_entry' && row.localRecordId) return { recordOrigin: 'local_entry', localRecordId: row.localRecordId };
  throw new Error('这条记录没有可用的资料来源。');
}

function rowKey(row: WorkbookRowListItem) {
  return row.recordOrigin === 'source'
    ? `source:${row.sourceSha256 ?? ''}:${row.sheetName}:${row.sourceRow ?? ''}`
    : `local_entry:${row.localRecordId ?? ''}`;
}

function originLabel(row: Pick<WorkbookRowListItem, 'recordOrigin'>) {
  return row.recordOrigin === 'source' ? '历史记录' : '补充记录';
}

function platformLabel(platform: WorkbookPlatform) {
  return ({ douyin: '抖音', channels: '视频号', xiaohongshu: '小红书', kuaishou: '快手', unknown: '未知平台' } as Record<WorkbookPlatform, string>)[platform];
}

function platformDetail(row: Pick<WorkbookRowListItem, 'platform' | 'platformSourceValue'>) {
  const label = platformLabel(row.platform);
  return row.platform === 'unknown' ? `${label} · 原文：${cellText(row.platformSourceValue)}` : label;
}

function sourceTimeLabel(value: string) {
  return formatDateTime(value);
}

function pageTitle(kind: WorkbookKind) {
  return kind === 'samples' ? '寄样记录' : '上播记录';
}

function pageDescription(kind: WorkbookKind) {
  return kind === 'samples'
    ? '查看寄样申请和进度。'
    : '查看上播计划和设置记录。';
}

function newFilters(): WorkbookFilters {
  return {
    sourceSha256: '', platform: '', year: '', sheetName: '', businessOwner: '', sourceStatus: '',
    fieldState: '', coordinationStatus: '', includeHidden: false, query: '', page: 1,
  };
}

function defaultFieldState(role: LocalWorkbookActor['role'] | '', kind: WorkbookKind): WorkbookFieldState | '' {
  if (role === 'local_shipping' && kind === 'samples') return 'tracking_missing';
  if (role === 'local_links' && kind === 'broadcast') return 'link_missing';
  return '';
}

function resolveFieldState(value: string, role: LocalWorkbookActor['role'] | '', kind: WorkbookKind): WorkbookFieldState | '' {
  if (value === 'all') return '';
  const valid = (['tracking_missing', 'tracking_recorded', 'link_missing', 'link_recorded'] as const).find((item) => item === value);
  if (!valid) return defaultFieldState(role, kind);
  if (kind === 'samples' && valid.startsWith('link_')) return defaultFieldState(role, kind);
  if (kind === 'broadcast' && valid.startsWith('tracking_')) return defaultFieldState(role, kind);
  if (role === 'local_shipping' && valid.startsWith('link_')) return defaultFieldState(role, kind);
  if (role === 'local_links' && valid.startsWith('tracking_')) return defaultFieldState(role, kind);
  return valid;
}

function sourceDateSort(sources: WorkbookSummary['sources']) {
  return [...sources].sort((a, b) => Date.parse(b.readAt) - Date.parse(a.readAt));
}

export default function WorkbookPage({ kind }: { kind: WorkbookKind }) {
  const { session } = useWorkbench();
  const workbook = useMemo(() => getWorkbookContext(session), [session]);
  if (!workbook) return <div className="page-stack workbook-page"><PageHeading title={pageTitle(kind)} description="当前没有可查看的资料。" /></div>;
  return <WorkbookWorkspacePage kind={kind} workbook={workbook} />;
}

function WorkbookWorkspacePage({ kind, workbook }: { kind: WorkbookKind; workbook: WorkbookContext }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedYear = searchParams.get('year') ?? '';
  const requestedPlatform = searchParams.get('platform') ?? '';
  const requestedFieldState = searchParams.get('fieldState') ?? '';
  const previousRequestedYear = useRef(requestedYear);
  const previousRequestedPlatform = useRef(requestedPlatform);
  const sessionSourceSha = workbook.sourceSha256 ?? '';
  const sessionLocalRole = workbook.role ?? '';
  const canViewPage = sessionLocalRole === 'local_manager' || sessionLocalRole === 'local_bd'
    || (sessionLocalRole === 'local_shipping' && kind === 'samples')
    || (sessionLocalRole === 'local_links' && kind === 'broadcast');
  const [filters, setFilters] = useState<WorkbookFilters>(() => ({
    ...newFilters(),
    year: /^\d{4}$/u.test(requestedYear) ? requestedYear : '',
    platform: WORKBOOK_PLATFORMS.find((platform) => platform === requestedPlatform) ?? '',
    fieldState: resolveFieldState(requestedFieldState, sessionLocalRole, kind),
  }));
  const [queryDraft, setQueryDraft] = useState('');
  const [catalog, setCatalog] = useState<WorkbookSummary | null>(null);
  const [facetSummary, setFacetSummary] = useState<WorkbookSummary | null>(null);
  const [scopedSummary, setScopedSummary] = useState<WorkbookSummary | null>(null);
  const [rows, setRows] = useState<WorkbookRowListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedRow, setSelectedRow] = useState<WorkbookRowListItem | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [rowsLoading, setRowsLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const [summaryError, setSummaryError] = useState('');
  const [rowsError, setRowsError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const lastDefaultScope = useRef('');
  const lastRole = useRef(sessionLocalRole);
  const previousFieldStateContext = useRef(`${sessionLocalRole}:${kind}:${requestedFieldState}`);

  useEffect(() => {
    if (lastRole.current === sessionLocalRole) return;
    lastRole.current = sessionLocalRole;
    lastDefaultScope.current = '';
    setSelectedRow(null);
    setCreateOpen(false);
    setFiltersExpanded(false);
    setCatalog(null);
    setFacetSummary(null);
    setScopedSummary(null);
    setRows([]);
    setTotal(0);
    setQueryDraft('');
    setFilters({ ...newFilters(), year: /^\d{4}$/u.test(requestedYear) ? requestedYear : '', platform: WORKBOOK_PLATFORMS.find((value) => value === requestedPlatform) ?? '', fieldState: resolveFieldState(requestedFieldState, sessionLocalRole, kind) });
    setCatalogLoading(true);
    setSummaryLoading(false);
    setRowsLoading(true);
    setCatalogError('');
    setSummaryError('');
    setRowsError('');
    setRefreshKey((current) => current + 1);
  }, [kind, requestedFieldState, requestedPlatform, requestedYear, sessionLocalRole]);

  useEffect(() => {
    if (!canViewPage) {
      setCatalog(null);
      setCatalogLoading(false);
      return;
    }
    let active = true;
    setCatalogLoading(true);
    setCatalogError('');
    void getWorkbookSummary({ kind, ...(sessionLocalRole === 'local_manager' ? { includeHidden: true } : {}) }, workbook).then((next) => {
      if (active) setCatalog(next);
    }).catch((error: unknown) => {
      if (active) setCatalogError(error instanceof Error ? error.message : '资料列表加载失败。');
    }).finally(() => {
      if (active) setCatalogLoading(false);
    });
    return () => { active = false; };
  }, [canViewPage, kind, refreshKey, sessionLocalRole, workbook]);

  const sources = useMemo(() => sourceDateSort(catalog?.sources ?? []), [catalog]);
  const selectedSource = sources.find((source) => source.sourceSha256 === filters.sourceSha256) ?? null;

  useEffect(() => {
    if (sources.length === 0) return;
    setFilters((current) => {
      if (sources.some((source) => source.sourceSha256 === current.sourceSha256)) return current;
      const preferred = sources.find((source) => source.sourceSha256 === sessionSourceSha);
      return { ...current, sourceSha256: preferred?.sourceSha256 ?? sources[0].sourceSha256, page: 1 };
    });
  }, [sessionSourceSha, sources]);

  useEffect(() => {
    if (!selectedSource) return;
    const scopeKey = `${kind}:${selectedSource.sourceSha256}`;
    if (lastDefaultScope.current === scopeKey) return;
    lastDefaultScope.current = scopeKey;
    const years = [...new Set(selectedSource.sheets.filter((sheet) => sheet.kind === kind && !sheet.hidden).map((sheet) => sheet.year).filter((year): year is number => year !== null))].sort((a, b) => b - a);
    const requested = requestedYear;
    const year = years.includes(Number(requested)) ? requested : years.includes(2026) ? '2026' : years[0] ? String(years[0]) : '';
    setFilters((current) => ({ ...current, year, sheetName: '', businessOwner: '', sourceStatus: '', coordinationStatus: '', page: 1 }));
  }, [kind, requestedYear, selectedSource]);

  useEffect(() => {
    if (previousRequestedYear.current === requestedYear) return;
    previousRequestedYear.current = requestedYear;
    if (requestedYear === 'all') {
      setFilters((current) => ({ ...current, year: '', sheetName: '', businessOwner: '', sourceStatus: '', page: 1 }));
      return;
    }
    if (!selectedSource) {
      setFilters((current) => ({ ...current, year: /^\d{4}$/u.test(requestedYear) ? requestedYear : '', sheetName: '', page: 1 }));
      return;
    }
    const years = [...new Set(selectedSource.sheets.filter((sheet) => sheet.kind === kind && !sheet.hidden).map((sheet) => sheet.year).filter((year): year is number => year !== null))].sort((a, b) => b - a);
    const year = /^\d{4}$/u.test(requestedYear) && years.includes(Number(requestedYear))
      ? requestedYear
      : years.includes(2026) ? '2026' : years[0] ? String(years[0]) : '';
    setFilters((current) => ({ ...current, year, sheetName: '', businessOwner: '', sourceStatus: '', page: 1 }));
  }, [kind, requestedYear, selectedSource]);

  useEffect(() => {
    if (previousRequestedPlatform.current === requestedPlatform) return;
    previousRequestedPlatform.current = requestedPlatform;
    const platform = WORKBOOK_PLATFORMS.find((value) => value === requestedPlatform) ?? '';
    setFilters((current) => ({ ...current, platform, page: 1 }));
  }, [requestedPlatform]);

  useEffect(() => {
    const contextKey = `${sessionLocalRole}:${kind}:${requestedFieldState}`;
    if (previousFieldStateContext.current === contextKey) return;
    previousFieldStateContext.current = contextKey;
    const fieldState = resolveFieldState(requestedFieldState, sessionLocalRole, kind);
    setFilters((current) => ({ ...current, fieldState, page: 1 }));
    if (requestedFieldState && requestedFieldState !== 'all' && fieldState !== requestedFieldState) {
      const next = new URLSearchParams(searchParams);
      next.set('fieldState', fieldState || 'all');
      setSearchParams(next, { replace: true });
    }
  }, [kind, requestedFieldState, searchParams, sessionLocalRole, setSearchParams]);

  const visibleSheets = useMemo(() => (selectedSource?.sheets ?? []).filter((sheet) => sheet.kind === kind && (filters.includeHidden || !sheet.hidden)), [filters.includeHidden, kind, selectedSource]);
  const availableYears = useMemo(() => [...new Set(visibleSheets.map((sheet) => sheet.year).filter((year): year is number => year !== null))].sort((a, b) => b - a), [visibleSheets]);
  const filterSheets = useMemo(() => visibleSheets.filter((sheet) => filters.year === '' || sheet.year === Number(filters.year)), [filters.year, visibleSheets]);
  const availableSheetNames = useMemo(() => [...new Set(filterSheets.map((sheet) => sheet.sheetName))].sort((a, b) => a.localeCompare(b)), [filterSheets]);
  const createSheets = useMemo(() => (catalog?.sheets ?? []).filter((sheet) => sheet.sourceSha256 === filters.sourceSha256 && sheet.kind === kind && !sheet.hidden && (filters.year === '' || sheet.year === Number(filters.year)) && sheet.manualCreateColumnKeys.length > 0), [catalog, filters.sourceSha256, filters.year, kind]);
  const canCreate = ['local_manager', 'local_bd'].includes(sessionLocalRole) && createSheets.length > 0;
  const facetBusinessOwners = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of facetSummary?.businessOwnerCounts ?? []) {
      if (item.kind !== kind || (filters.platform && item.platform !== filters.platform)) continue;
      counts.set(item.value, (counts.get(item.value) ?? 0) + item.count);
    }
    if (!counts.has(WORKBOOK_BLANK_SOURCE_STATUS)) counts.set(WORKBOOK_BLANK_SOURCE_STATUS, 0);
    return [...counts.keys()].sort((left, right) => left === WORKBOOK_BLANK_SOURCE_STATUS ? -1 : right === WORKBOOK_BLANK_SOURCE_STATUS ? 1 : left.localeCompare(right));
  }, [facetSummary, filters.platform, kind]);
  const facetSourceStatuses = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of facetSummary?.sourceStatusCounts ?? []) {
      if (item.kind !== kind || (filters.platform && item.platform !== filters.platform)) continue;
      counts.set(item.value, (counts.get(item.value) ?? 0) + item.count);
    }
    return [...counts.entries()].sort(([left], [right]) => left === WORKBOOK_BLANK_SOURCE_STATUS ? -1 : right === WORKBOOK_BLANK_SOURCE_STATUS ? 1 : left.localeCompare(right));
  }, [facetSummary, filters.platform, kind]);

  useEffect(() => {
    if (!catalog || !canViewPage) return;
    if (filters.year !== '' && !availableYears.includes(Number(filters.year))) {
      setFilters((current) => ({ ...current, year: '', sheetName: '', businessOwner: '', sourceStatus: '', page: 1 }));
      return;
    }
    if (filters.sheetName && !availableSheetNames.includes(filters.sheetName)) {
      setFilters((current) => ({ ...current, sheetName: '', businessOwner: '', sourceStatus: '', page: 1 }));
      return;
    }
    if (filters.businessOwner && !facetBusinessOwners.includes(filters.businessOwner)) {
      setFilters((current) => ({ ...current, businessOwner: '', page: 1 }));
      return;
    }
    if (filters.sourceStatus && !facetSourceStatuses.some(([value]) => value === filters.sourceStatus)) {
      setFilters((current) => ({ ...current, sourceStatus: '', page: 1 }));
    }
  }, [availableSheetNames, availableYears, catalog, facetBusinessOwners, facetSourceStatuses, filters.businessOwner, filters.sheetName, filters.sourceStatus, filters.year]);

  const facetFilters = useMemo<WorkbookListFilters>(() => ({
    kind,
    ...(filters.platform ? { platform: filters.platform } : {}),
    ...(filters.fieldState ? { fieldState: filters.fieldState } : {}),
    ...(filters.sourceSha256 ? { sourceSha256: filters.sourceSha256 } : {}),
    ...(filters.year ? { year: Number(filters.year) } : {}),
    ...(filters.sheetName ? { sheetName: filters.sheetName } : {}),
    ...(filters.coordinationStatus ? { coordinationStatus: filters.coordinationStatus } : {}),
    includeHidden: filters.includeHidden,
  }), [filters.coordinationStatus, filters.fieldState, filters.includeHidden, filters.platform, filters.sheetName, filters.sourceSha256, filters.year, kind]);

  const summaryFilters = useMemo<WorkbookListFilters>(() => ({
    ...facetFilters,
    ...(filters.businessOwner ? { businessOwner: filters.businessOwner } : {}),
    ...(filters.sourceStatus ? { sourceStatus: filters.sourceStatus } : {}),
    ...(filters.query ? { query: filters.query } : {}),
  }), [facetFilters, filters.businessOwner, filters.query, filters.sourceStatus]);

  useEffect(() => {
    if (!catalog || !canViewPage) return;
    let active = true;
    setSummaryError('');
    void getWorkbookSummary(facetFilters, workbook).then((next) => {
      if (active) setFacetSummary(next);
    }).catch((error: unknown) => {
      if (active) setSummaryError(error instanceof Error ? error.message : '筛选项加载失败。');
    });
    return () => { active = false; };
  }, [canViewPage, catalog, facetFilters, refreshKey, workbook]);

  useEffect(() => {
    if (!catalog || !canViewPage) return;
    let active = true;
    setSummaryLoading(true);
    setSummaryError('');
    void getWorkbookSummary(summaryFilters, workbook).then((next) => {
      if (active) setScopedSummary(next);
    }).catch((error: unknown) => {
      if (active) setSummaryError(error instanceof Error ? error.message : '状态汇总加载失败。');
    }).finally(() => {
      if (active) setSummaryLoading(false);
    });
    return () => { active = false; };
  }, [canViewPage, catalog, refreshKey, summaryFilters, workbook]);

  const listFilters = useMemo<WorkbookListFilters>(() => ({
    kind,
    ...(filters.platform ? { platform: filters.platform } : {}),
    ...(filters.fieldState ? { fieldState: filters.fieldState } : {}),
    ...(filters.sourceSha256 ? { sourceSha256: filters.sourceSha256 } : {}),
    ...(filters.year ? { year: Number(filters.year) } : {}),
    ...(filters.sheetName ? { sheetName: filters.sheetName } : {}),
    ...(filters.businessOwner ? { businessOwner: filters.businessOwner } : {}),
    ...(filters.sourceStatus ? { sourceStatus: filters.sourceStatus } : {}),
    ...(filters.coordinationStatus ? { coordinationStatus: filters.coordinationStatus } : {}),
    ...(filters.query ? { query: filters.query } : {}),
    includeHidden: filters.includeHidden,
    page: filters.page,
    pageSize: PAGE_SIZE,
  }), [filters.businessOwner, filters.coordinationStatus, filters.fieldState, filters.includeHidden, filters.page, filters.platform, filters.query, filters.sheetName, filters.sourceSha256, filters.sourceStatus, filters.year, kind]);

  useEffect(() => {
    if (!catalog || !canViewPage) return;
    if (sources.length > 0 && !filters.sourceSha256) return;
    let active = true;
    setRowsLoading(true);
    setRowsError('');
    setRows([]);
    setTotal(0);
    if (sources.length === 0) {
      setRows([]);
      setTotal(0);
      setRowsLoading(false);
      return () => { active = false; };
    }
    void listWorkbookRows(listFilters, workbook).then((result) => {
      if (!active) return;
      setRows(result.rows);
      setTotal(result.total);
    }).catch((error: unknown) => {
      if (active) setRowsError(error instanceof Error ? error.message : '记录加载失败。');
    }).finally(() => {
      if (active) setRowsLoading(false);
    });
    return () => { active = false; };
  }, [canViewPage, catalog, filters.sourceSha256, listFilters, refreshKey, sources.length, workbook]);

  function updateFilters(patch: Partial<WorkbookFilters>) {
    setFilters((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updateFilters({ query: queryDraft.trim() });
  }

  function selectYear(year: string) {
    updateFilters({ year, sheetName: '', businessOwner: '', sourceStatus: '' });
    const next = new URLSearchParams(searchParams);
    next.set('year', year || 'all');
    setSearchParams(next, { replace: true });
  }

  function clearFilters() {
    const currentYear = filters.year;
    const currentPlatform = filters.platform;
    const currentFieldState = filters.fieldState;
    setQueryDraft('');
    setFiltersExpanded(false);
    setFilters((current) => ({ ...newFilters(), sourceSha256: current.sourceSha256, year: currentYear, platform: currentPlatform, fieldState: currentFieldState }));
  }

  function selectFieldState(fieldState: WorkbookFieldState | '') {
    updateFilters({ fieldState });
    const next = new URLSearchParams(searchParams);
    next.set('fieldState', fieldState || 'all');
    setSearchParams(next, { replace: true });
  }

  function refresh() {
    setRefreshKey((current) => current + 1);
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const previewBrand = isUnavailableDemoBrand({ name: workbook.brandName });
  const title = previewBrand ? pageTitle(kind) : `${workbook.brandName} · ${pageTitle(kind)}`;
  const displayColumns = useMemo(() => tableColumns(rows, kind, sessionLocalRole || 'local_manager'), [kind, rows, sessionLocalRole]);
  const showLocalStatus = sessionLocalRole === 'local_manager' || sessionLocalRole === 'local_shipping';
  const showSidecarNotes = ['local_manager', 'local_bd', 'local_shipping'].includes(sessionLocalRole);
  const showBusinessOwnerFilter = sessionLocalRole === 'local_manager' || sessionLocalRole === 'local_bd';
  const showCoordinationFilter = sessionLocalRole === 'local_manager' || sessionLocalRole === 'local_shipping';
  const showHiddenFilter = sessionLocalRole === 'local_manager';

  if (!canViewPage) return <div className="page-stack workbook-page"><PageHeading title={title} description={pageDescription(kind)} /><div className="notice notice-warning"><ShieldCheck size={14} /><span>你没有查看此页的权限，请返回工作台。</span></div></div>;

  return <div className="page-stack workbook-page">
    <PageHeading title={title} description={previewBrand ? '当前打开的是已停用的预览资料，不是 来源品牌 历史记录。请从品牌里打开 来源品牌。' : pageDescription(kind)} actions={<Button variant="outline" onClick={refresh} disabled={catalogLoading || rowsLoading} aria-label="刷新记录"><RefreshCw size={14} />刷新</Button>} />
    <details className="workbook-provenance-details">
      <summary className="workbook-provenance-summary">
        <FileSpreadsheet size={16} aria-hidden="true" />
        <span className="workbook-provenance-copy"><strong>{selectedSource?.sourceFileName ?? (catalogLoading ? '正在加载资料…' : '暂无资料文件')}</strong><span>{selectedSource ? `导入于 ${sourceTimeLabel(selectedSource.readAt)}` : '请导入寄样或上播资料'}</span></span>
        <span className="workbook-local-badge"><FileSpreadsheet size={13} />资料来源</span>
        <ChevronDown size={15} className="workbook-provenance-chevron" aria-hidden="true" />
      </summary>
      {selectedSource && <div className="workbook-provenance-content">
        <span><strong>资料文件</strong>{selectedSource.sourceFileName}</span>
        <span><strong>导入时间</strong>{sourceTimeLabel(selectedSource.readAt)}</span>
      </div>}
    </details>

    {catalogError && <div className="notice notice-error" role="alert">{catalogError}<Button variant="outline" size="sm" onClick={refresh}>重试</Button></div>}
    {summaryError && <div className="notice notice-error" role="alert">{summaryError}<Button variant="outline" size="sm" onClick={refresh}>重试</Button></div>}
    {rowsError && <div className="notice notice-error" role="alert">{rowsError}<Button variant="outline" size="sm" onClick={refresh}>重试</Button></div>}

    <Panel title={kind === 'samples' ? '寄样记录' : '上播记录'} className="workbook-list-panel">
      <form className={`workbook-filters${showBusinessOwnerFilter ? ' workbook-filters-with-owner' : ''}`} onSubmit={submitSearch}>
        <label className="workbook-filter-field"><span>资料来源</span><select className="filter-select" value={filters.sourceSha256} onChange={(event) => updateFilters({ sourceSha256: event.target.value, year: '', sheetName: '', businessOwner: '', sourceStatus: '' })} aria-label="按资料来源筛选">
          {sources.length === 0 && <option value="">暂无资料</option>}
          {sources.map((source) => <option value={source.sourceSha256} key={source.sourceSha256}>{source.sourceFileName} · {sourceTimeLabel(source.readAt)}</option>)}
        </select></label>
        <label className="workbook-filter-field"><span>年份</span><select className="filter-select" value={filters.year} onChange={(event) => selectYear(event.target.value)} aria-label="按年份筛选"><option value="">全部年份</option>{availableYears.map((year) => <option value={year} key={year}>{year} 年</option>)}</select></label>
        <label className="workbook-filter-field"><span>资料表</span><select className="filter-select" value={filters.sheetName} onChange={(event) => updateFilters({ sheetName: event.target.value, businessOwner: '', sourceStatus: '' })} aria-label="按资料表筛选"><option value="">全部资料表</option>{availableSheetNames.map((name) => <option value={name} key={name}>{name}</option>)}</select></label>
        {showBusinessOwnerFilter && <label className="workbook-filter-field"><span>{businessOwnerLabel(kind)}</span><select className="filter-select" value={filters.businessOwner} onChange={(event) => updateFilters({ businessOwner: event.target.value })} aria-label={`按${businessOwnerLabel(kind)}筛选`}><option value="">全部商务</option>{facetBusinessOwners.map((owner) => <option value={owner} key={owner}>{owner === WORKBOOK_BLANK_SOURCE_STATUS ? '未填写商务' : owner}</option>)}</select></label>}
        <label className="workbook-filter-field workbook-search-filter"><span>关键词</span><div className="search-field"><Search size={14} aria-hidden="true" /><input value={queryDraft} onChange={(event) => setQueryDraft(event.target.value)} placeholder="搜索记录、备注或下一步" aria-label="搜索记录" /></div></label>
        <div className="workbook-filter-actions"><Button type="submit" size="sm"><Search size={14} />搜索</Button><Button type="button" size="sm" variant="outline" onClick={clearFilters}>清空条件</Button><button type="button" className="workbook-filter-toggle" aria-expanded={filtersExpanded} onClick={() => setFiltersExpanded((current) => !current)}>{filtersExpanded ? '收起筛选' : '展开筛选'}<ChevronDown size={13} className={filtersExpanded ? 'is-expanded' : ''} /></button></div>
        {filtersExpanded && <div className="workbook-filter-advanced">
          <label className="workbook-filter-field"><span>{kind === 'samples' ? '寄样状态' : '上播状态'}</span><select className="filter-select" value={filters.sourceStatus} onChange={(event) => updateFilters({ sourceStatus: event.target.value })} aria-label={`按${sourceStatusLabel(kind)}筛选`}><option value="">全部状态</option>{facetSourceStatuses.map(([value, count]) => <option value={value} key={value}>{value === WORKBOOK_BLANK_SOURCE_STATUS ? '空白' : value}（{count}）</option>)}</select></label>
          {showCoordinationFilter && <label className="workbook-filter-field"><span>处理状态</span><select className="filter-select" value={filters.coordinationStatus} onChange={(event) => updateFilters({ coordinationStatus: event.target.value as WorkbookCoordinationStatus | '' })} aria-label="按处理状态筛选"><option value="">全部状态</option>{WORKBOOK_COORDINATION_STATUSES.map((status) => <option value={status} key={status}>{coordinationLabels[status]}</option>)}</select></label>}
          {showHiddenFilter && <label className="check-row"><input type="checkbox" checked={filters.includeHidden} onChange={(event) => updateFilters({ includeHidden: event.target.checked, sheetName: '', businessOwner: '', sourceStatus: '' })} />显示隐藏记录</label>}
        </div>}
      </form>

      <div className="tab-row workbook-field-state-tabs" role="group" aria-label={kind === 'samples' ? '按快递单号登记状态筛选' : '按上播链接登记状态筛选'}>
        <span className="workbook-status-caption">{kind === 'samples' ? '运单状态' : '链接状态'}</span>
        {fieldStateChoices(kind).map((option) => <button type="button" aria-pressed={filters.fieldState === option.value} className="tab-button" key={option.value || 'all'} onClick={() => selectFieldState(option.value)}>{option.label}</button>)}
      </div>
      <div className="workbook-operation-row">
        <div className="workbook-scope-stats"><span><strong>{scopedSummary?.totals.rows ?? (summaryLoading ? '…' : 0)}</strong> 条记录</span><span>历史记录 {scopedSummary?.totals.sourceRows ?? 0}</span><span>补充记录 {scopedSummary?.totals.manualRows ?? 0}</span><span>待核对 {scopedSummary?.totals.rowsWithIssues ?? 0}</span></div>
        <div className="workbook-operation-actions">
          {canCreate && <Button size="sm" onClick={() => setCreateOpen(true)}>{kind === 'samples' ? '新建寄样需求' : '登记上播设置需求'}</Button>}
        </div>
      </div>
      <div className="workbook-list-meta"><span>{rowsLoading ? '正在读取记录…' : `当前筛选 ${total} 条`}{filters.fieldState && <span className="workbook-list-state-note"> · {fieldStateChoices(kind).find((option) => option.value === filters.fieldState)?.label}</span>}</span><span>第 {Math.min(filters.page, totalPages)} / {totalPages} 页 · 每页 {PAGE_SIZE} 条</span></div>

      {rows.length > 0 ? <div className="table-wrap workbook-table-wrap"><table className="data-table workbook-table"><thead><tr>
        <th className="workbook-source-col">来源 / 平台</th>
        {displayColumns.map((column) => <th key={column.id}>{column.label}</th>)}
        {showLocalStatus && <th>处理状态</th>}{showSidecarNotes && <th>岗位备注 / 下一步</th>}<th>核对</th><th className="text-right workbook-action-col">操作</th>
      </tr></thead><tbody>{rows.map((row) => <WorkbookTableRow key={rowKey(row)} kind={kind} row={row} role={sessionLocalRole || 'local_manager'} columns={displayColumns} onOpen={() => setSelectedRow(row)} />)}</tbody></table></div>
        : rowsLoading ? <div className="workbook-loading-state"><span className="spin" aria-hidden="true" />正在读取本页记录</div>
          : sources.length === 0 ? <EmptyState title={kind === 'samples' ? '暂无寄样记录' : '暂无上播记录'} description="导入相关资料后，记录会显示在这里。" />
            : <EmptyState title="没有符合条件的记录" description="调整年份、资料表、商务或状态筛选，也可以清空关键词。" action={<Button size="sm" variant="outline" onClick={clearFilters}>清空筛选</Button>} />}

      <div className="pagination-row workbook-pagination"><span>{total ? `显示 ${(filters.page - 1) * PAGE_SIZE + 1}–${Math.min(filters.page * PAGE_SIZE, total)} 条，共 ${total} 条` : '共 0 条'}</span><div><Button size="sm" variant="outline" disabled={filters.page <= 1 || rowsLoading} onClick={() => updateFilters({ page: filters.page - 1 })}>上一页</Button><Button size="sm" variant="outline" disabled={filters.page >= totalPages || rowsLoading} onClick={() => updateFilters({ page: filters.page + 1 })}>下一页</Button></div></div>
    </Panel>

    {createOpen && <ManualCreateDialog kind={kind} workbook={workbook} sheets={createSheets} role={sessionLocalRole} preferredSheetName={filters.sheetName} platform={filters.platform} onOpenChange={setCreateOpen} onCreated={(created) => { refresh(); setSelectedRow(created); }} />}
    {selectedRow && <WorkbookDetailDialog key={rowKey(selectedRow)} kind={kind} workbook={workbook} row={selectedRow} role={sessionLocalRole || 'local_manager'} onOpenChange={(open) => { if (!open) setSelectedRow(null); }} onSaved={() => { refresh(); setSelectedRow(null); }} />}
  </div>;
}

type DisplayColumn = { id: string; key: string; label: string };

function tableColumns(rows: WorkbookRowListItem[], kind: WorkbookKind, role: LocalWorkbookActor['role']): DisplayColumn[] {
  const columns = new Map<string, DisplayColumn>();
  for (const row of rows) for (const column of row.columns.filter((item) => row.readableColumnKeys.includes(item.key) || (canRevealSensitive(role, kind) && isSensitiveColumn(kind, row, item)))) {
    const id = `${column.key}:${column.label}`;
    if (!columns.has(id)) columns.set(id, { id, key: column.key, label: column.label });
  }
  return [...columns.values()];
}

function WorkbookTableRow({ kind, row, role, columns, onOpen }: { kind: WorkbookKind; row: WorkbookRowListItem; role: LocalWorkbookActor['role']; columns: DisplayColumn[]; onOpen: () => void }) {
  const revealAllowed = canRevealSensitive(role, kind);
  const safeColumns = row.columns.filter((column) => row.readableColumnKeys.includes(column.key) || (revealAllowed && isSensitiveColumn(kind, row, column)));
  const editableColumns = safeColumns.filter((column) => row.editableColumnKeys.includes(column.key));
  const showLocalStatus = role === 'local_manager' || role === 'local_shipping';
  const sidecarNote = role === 'local_bd' ? row.businessNote
    : role === 'local_shipping' ? row.logisticsNote
      : role === 'local_manager' ? row.businessNote || row.logisticsNote || row.collaborationNote : null;
  const nextAction = role === 'local_manager' ? row.nextAction : null;
  return <tr>
    <td className="workbook-source-col"><button type="button" className="workbook-source-open" onClick={onOpen} aria-label={`打开${originLabel(row)}详情`}><span className="table-primary">{row.sourceRow === null ? '补充记录' : '历史记录'}</span><span className="table-secondary">{row.sheetName} · {platformDetail(row)}</span></button></td>
    {columns.map((column) => {
      const rowColumn = safeColumns.find((item) => item.key === column.key && item.label === column.label);
      const sensitive = Boolean(rowColumn && isSensitiveColumn(kind, row, rowColumn));
      const value = sensitive ? '详情查看' : rowColumn && row.readableColumnKeys.includes(column.key) ? cellText(row.cells[column.key]) : '—';
      const isEditable = rowColumn && editableColumns.some((editable) => editable.key === rowColumn.key) && !sensitive;
      return <td key={column.id} title={sensitive ? '敏感字段默认隐藏，请进入详情并主动查看。' : rowColumn ? `${column.label}：${value}` : undefined}>{sensitive ? <span className="workbook-sensitive-placeholder"><Eye size={12} />详情查看</span> : <span className="workbook-cell-value">{value}</span>}{isEditable && Object.prototype.hasOwnProperty.call(row.columnEdits, column.key) && <span className="workbook-edited-marker">已修改</span>}</td>;
    })}
    {showLocalStatus && <td><StatusPill value={row.collaborationStatus} label={coordinationLabels[row.collaborationStatus]} tone={statusTone(row.collaborationStatus)} /></td>}
    {role !== 'local_links' && <td className="workbook-followup-cell"><span className="table-primary">{sidecarNote || '—'}</span>{role === 'local_manager' && row.logisticsNote && row.logisticsNote !== sidecarNote && <span className="table-secondary">物流：{row.logisticsNote}</span>}{nextAction && <span className="table-secondary">下一步：{nextAction}{row.nextActionDueAt ? ` · ${formatDateTime(row.nextActionDueAt)}` : ''}</span>}</td>}
    <td>{row.issues.length > 0 ? <span className="workbook-issue-count"><TriangleAlert size={13} />{row.issues.length} 项</span> : <span className="text-muted">—</span>}</td>
    <td className="table-action-cell workbook-action-col"><Button size="sm" variant="outline" className="workbook-row-action" onClick={onOpen}>{role === 'local_shipping' ? '寄样履约' : role === 'local_links' ? '设置明细' : role === 'local_bd' ? '商务备注' : '查看详情'}</Button></td>
  </tr>;
}

function statusTone(status: WorkbookCoordinationStatus): 'neutral' | 'blue' | 'green' | 'orange' {
  if (status === 'resolved') return 'green';
  if (status === 'waiting') return 'orange';
  if (status === 'in_progress') return 'blue';
  return 'neutral';
}

type EditableDraft = {
  status: WorkbookCoordinationStatus;
  note: string;
  businessNote: string;
  logisticsNote: string;
  nextAction: string;
  dueAt: string;
  columns: Record<string, string>;
  reason: string;
};

type WorkbookBaseline = {
  status: WorkbookCoordinationStatus;
  note: string;
  businessNote: string;
  logisticsNote: string;
  nextAction: string;
  dueAt: string;
  columns: Record<string, string | null>;
};

function WorkbookDetailDialog({ kind, workbook, row, role, onOpenChange, onSaved }: { kind: WorkbookKind; workbook: WorkbookContext; row: WorkbookRowListItem; role: LocalWorkbookActor['role']; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const [detail, setDetail] = useState<WorkbookRowDetail | null>(null);
  const [draft, setDraft] = useState<EditableDraft>({ status: row.collaborationStatus, note: row.collaborationNote ?? '', businessNote: row.businessNote ?? '', logisticsNote: row.logisticsNote ?? '', nextAction: row.nextAction ?? '', dueAt: toLocalDateTime(row.nextActionDueAt), columns: {}, reason: '' });
  const [loading, setLoading] = useState(true);
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const baseline = useRef<WorkbookBaseline | null>(null);
  const selector = rowSelector(row);

  function initialize(record: WorkbookRowDetail) {
    const columns = record.columns.filter((column) => record.editableColumnKeys.includes(column.key) && record.readableColumnKeys.includes(column.key));
    const values = Object.fromEntries(columns.filter((column) => !isSensitiveColumn(kind, record, column) || record.sensitiveValuesIncluded).map((column) => [column.key, toInputValue(record.cells[column.key])]));
    const managerRole = role === 'local_manager';
    const businessNote = managerRole || role === 'local_bd' ? record.businessNote ?? '' : '';
    const logisticsNote = managerRole || role === 'local_shipping' ? record.logisticsNote ?? '' : '';
    const note = managerRole ? record.collaborationNote ?? '' : '';
    const nextAction = managerRole ? record.nextAction ?? '' : '';
    const nextActionDueAt = managerRole ? toLocalDateTime(record.nextActionDueAt) : '';
    const nextDraft: EditableDraft = {
      status: record.collaborationStatus,
      note,
      businessNote,
      logisticsNote,
      nextAction,
      dueAt: nextActionDueAt,
      columns: values,
      reason: '',
    };
    baseline.current = {
      status: nextDraft.status,
      note,
      businessNote,
      logisticsNote,
      nextAction: nextDraft.nextAction,
      dueAt: nextDraft.dueAt,
      columns: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === '' ? null : value])),
    };
    setDraft(nextDraft);
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    void getWorkbookRowDetail(selector, workbook, false).then((next) => {
      if (!active) return;
      setDetail(next);
      initialize(next);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : '记录详情暂时无法加载。');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  // The dialog is keyed by row selector, so one fetch per opened row is intentional.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const readableColumns = detail?.columns.filter((column) => detail.readableColumnKeys.includes(column.key)) ?? [];
  const editableColumns = detail?.columns.filter((column) => detail.editableColumnKeys.includes(column.key)) ?? [];
  const sensitiveColumns = detail ? detail.columns.filter((column) => isSensitiveColumn(kind, detail, column)) : [];
  const detailColumns = detail ? detail.columns.filter((column) => detail.readableColumnKeys.includes(column.key) || (canRevealSensitive(role, kind) && isSensitiveColumn(kind, detail, column))) : [];
  const visibleEditableColumns = editableColumns.filter((column) => detail?.readableColumnKeys.includes(column.key) && (!isSensitiveColumn(kind, detail ?? row, column) || revealed));
  const isReadOnly = Boolean(detail?.sourceSheetHidden);
  const canEditStatus = role === 'local_manager' || role === 'local_shipping';
  const canEditBusinessNote = role === 'local_manager' || role === 'local_bd';
  const canEditLogisticsNote = role === 'local_manager' || role === 'local_shipping';
  const canEditManagerNotes = role === 'local_manager';
  const canSave = !isReadOnly && (editableColumns.length > 0 || canEditStatus || canEditBusinessNote || canEditLogisticsNote || canEditManagerNotes);

  async function toggleSensitive() {
    if (!detail) return;
    const nextVisible = !revealed;
    setRevealing(true);
    setError('');
    try {
      const fresh = await getWorkbookRowDetail(selector, workbook, nextVisible);
      if (fresh.version !== detail.version) setConflict(true);
      setDetail(fresh);
      setRevealed(nextVisible);
      if (nextVisible) {
        const sensitiveValues = editableColumns.filter((column) => fresh.readableColumnKeys.includes(column.key) && isSensitiveColumn(kind, fresh, column)).reduce<Record<string, string>>((values, column) => {
          values[column.key] = toInputValue(fresh.cells[column.key]);
          return values;
        }, {});
        setDraft((current) => ({ ...current, columns: { ...sensitiveValues, ...current.columns } }));
        if (baseline.current) {
          const currentBaseline = baseline.current;
          const newBaselineValues = Object.fromEntries(Object.entries(sensitiveValues).filter(([key]) => !Object.prototype.hasOwnProperty.call(currentBaseline.columns, key)).map(([key, value]) => [key, value === '' ? null : value]));
          baseline.current = { ...currentBaseline, columns: { ...newBaselineValues, ...currentBaseline.columns } };
        }
      } else {
        const sensitiveKeys = editableColumns.filter((column) => isSensitiveColumn(kind, detail, column)).map((column) => column.key);
        setDraft((current) => {
          const columns = { ...current.columns };
          sensitiveKeys.forEach((key) => { delete columns[key]; });
          return { ...current, columns };
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '敏感信息暂时无法加载。');
    } finally {
      setRevealing(false);
    }
  }

  async function refreshVersionAfterConflict() {
    setRevealing(true);
    try {
      const fresh = await getWorkbookRowDetail(selector, workbook, revealed);
      setDetail(fresh);
      setConflict(true);
      setError('这条记录已更新。你的填写已保留，请核对最新内容后再保存。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '记录暂时无法刷新，请重试。');
    } finally {
      setRevealing(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if (!detail || !baseline.current) return;
    if (isReadOnly) { setError('这张资料表已隐藏，不能修改。'); return; }
    if (!draft.reason.trim()) { setError('请填写本次更新原因。'); return; }

    const currentBaseline = baseline.current;
    const patch: WorkbookUpdatePatch = {};
    if (canEditStatus && draft.status !== currentBaseline.status) patch.coordinationStatus = draft.status;
    if (canEditManagerNotes && draft.note !== currentBaseline.note) patch.collaborationNote = draft.note === '' ? null : draft.note;
    if (canEditBusinessNote && draft.businessNote !== currentBaseline.businessNote) patch.businessNote = draft.businessNote === '' ? null : draft.businessNote;
    if (canEditLogisticsNote && draft.logisticsNote !== currentBaseline.logisticsNote) patch.logisticsNote = draft.logisticsNote === '' ? null : draft.logisticsNote;
    if (canEditManagerNotes && draft.nextAction !== currentBaseline.nextAction) patch.nextAction = draft.nextAction === '' ? null : draft.nextAction;
    if (canEditManagerNotes && draft.dueAt !== currentBaseline.dueAt) patch.nextActionDueAt = draft.dueAt ? shanghaiInputToIso(draft.dueAt) : null;

    const columnEdits: Record<string, string | null> = {};
    const sensitiveKeys: string[] = [];
    let hiddenSensitiveDirty = false;
    for (const column of editableColumns) {
      const sensitive = isSensitiveColumn(kind, detail, column);
      const initialValue = currentBaseline.columns[column.key];
      const currentValue = draft.columns[column.key];
      if (currentValue === undefined || (currentValue === '' ? null : currentValue) === initialValue) continue;
      if (sensitive && !revealed) { hiddenSensitiveDirty = true; continue; }
      columnEdits[column.key] = currentValue === '' ? null : currentValue;
      if (sensitive) sensitiveKeys.push(column.key);
    }
    if (hiddenSensitiveDirty) { setError('请重新查看敏感信息后再保存。'); return; }
    if (Object.keys(columnEdits).length > 0) patch.columnEdits = columnEdits;
    if (Object.keys(patch).length === 0) { setError('协作内容没有变化。'); return; }

    setSaving(true);
    try {
      await updateWorkbookRow({
        ...selector,
        expectedVersion: detail.version,
        reason: draft.reason,
        ...(sensitiveKeys.length > 0 ? { revealedSensitiveColumnKeys: sensitiveKeys } : {}),
        patch,
      }, workbook);
      toast.success('更新已保存');
      onSaved();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'VERSION_CONFLICT') {
        setConflict(true);
        try {
          const latest = await getWorkbookRowDetail(selector, workbook, revealed);
          setDetail(latest);
          setError('这条记录刚刚更新。你的填写仍保留，请核对当前内容后再保存。');
        } catch {
          setError('此行刚被更新，你填写的内容仍保留。请刷新最新版本后再保存。');
        }
      } else {
        setError(cause instanceof Error ? cause.message : '保存失败，请重试。');
      }
    } finally {
      setSaving(false);
    }
  }

  return <Modal open onOpenChange={onOpenChange} title={kind === 'samples' ? '寄样记录详情' : '上播记录详情'} className="modal-wide workbook-detail-modal">
    {loading ? <div className="workbook-loading-state"><span className="spin" aria-hidden="true" />正在加载记录详情</div> : detail ? <div className="workbook-detail-content">
      <div className="workbook-detail-provenance">
        <span><strong>记录来源</strong>{originLabel(detail)}</span>
        {(detail.sourceFileName ?? detail.templateSourceFileName) && <span><strong>资料文件</strong>{detail.sourceFileName ?? detail.templateSourceFileName}</span>}
      </div>
      {detail.issues.length > 0 && <div className="notice notice-warning"><TriangleAlert size={14} /><span>这条记录有 {detail.issues.length} 项待核对内容。</span></div>}
      {conflict && <div className="notice notice-warning workbook-conflict-notice"><TriangleAlert size={14} /><div><strong>这条记录已更新</strong><span>你的填写仍保留，请刷新后重新确认。</span></div><Button size="sm" variant="outline" onClick={() => void refreshVersionAfterConflict()} disabled={revealing}><RefreshCw size={13} />刷新记录</Button></div>}
      {detail.sourceSheetHidden && <div className="notice notice-warning"><TriangleAlert size={14} />这张资料表已隐藏，只能查看。</div>}

      <section className="workbook-detail-section" aria-labelledby="workbook-source-title">
        <div className="workbook-detail-section-heading"><div><h3 id="workbook-source-title">记录内容</h3></div>{canRevealSensitive(role, kind) && sensitiveColumns.length > 0 && <Button size="sm" variant="outline" onClick={() => void toggleSensitive()} disabled={revealing}>{revealed ? <EyeOff size={14} /> : <Eye size={14} />}{revealing ? '读取中…' : revealed ? '隐藏敏感信息' : '查看敏感信息'}</Button>}</div>
        {canRevealSensitive(role, kind) && sensitiveColumns.length > 0 && <div className="notice notice-info workbook-sensitive-note"><ShieldCheck size={14} /><span>{revealed ? '敏感信息已展开。查看完毕后请点击“隐藏敏感信息”。' : '收件信息和上播链接默认隐藏。点击“查看敏感信息”后可核对。'}</span></div>}
        <div className="workbook-source-fields">{detailColumns.map((column) => {
          const sensitive = isSensitiveColumn(kind, detail, column);
          const baselineCells = detail.recordOrigin === 'source' ? detail.sourceCells ?? detail.baselineCells : detail.baselineCells;
          const canRead = detail.readableColumnKeys.includes(column.key);
          const value = sensitive && (!revealed || !canRead) ? '已隐藏' : cellText(baselineCells[column.key]);
          return <div className={`workbook-source-field${sensitive ? ' is-sensitive' : ''}`} key={column.key}><span>{column.label}{sensitive && <em>敏感</em>}</span><strong>{value}</strong></div>;
        })}</div>
      </section>

      <form className="workbook-edit-form" onSubmit={submit}>
        <section className="workbook-detail-section" aria-labelledby="workbook-sidecar-title">
          <div className="workbook-detail-section-heading"><div><h3 id="workbook-sidecar-title">跟进信息</h3></div></div>
          {canEditStatus && <div className="workbook-edit-grid"><FormField label="处理状态"><select className="native-select" value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as WorkbookCoordinationStatus }))} disabled={isReadOnly}><option value="unreviewed">未标记</option><option value="in_progress">跟进中</option><option value="waiting">待确认</option><option value="resolved">已处理</option><option value="on_hold">暂缓</option></select></FormField></div>}
          <div className="workbook-edit-grid">
            {canEditBusinessNote && <FormField label="商务备注" className="span-2"><Textarea rows={2} value={draft.businessNote} onChange={(event) => setDraft((current) => ({ ...current, businessNote: event.target.value }))} disabled={isReadOnly} placeholder="记录本人确认的业务需求或沟通进展" /></FormField>}
            {canEditLogisticsNote && <FormField label="物流备注" className="span-2"><Textarea rows={2} value={draft.logisticsNote} onChange={(event) => setDraft((current) => ({ ...current, logisticsNote: event.target.value }))} disabled={isReadOnly} placeholder="记录发货、物流或签收进展" /></FormField>}
            {canEditManagerNotes && <><FormField label="管理备注" className="span-2"><Textarea rows={2} value={draft.note} onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))} disabled={isReadOnly} placeholder="补充管理协作信息" /></FormField><FormField label="下一步行动" className="span-2"><Textarea rows={2} value={draft.nextAction} onChange={(event) => setDraft((current) => ({ ...current, nextAction: event.target.value }))} disabled={isReadOnly} placeholder="写清下一步要做的事" /></FormField><FormField label="下一步期限" hint="用于安排跟进，不是上播时间。"><Input type="datetime-local" value={draft.dueAt} onChange={(event) => setDraft((current) => ({ ...current, dueAt: event.target.value }))} disabled={isReadOnly} /></FormField></>}
          </div>
          {visibleEditableColumns.length > 0 && <div className="workbook-column-edits"><h4>可修改字段</h4><div className="workbook-edit-grid">{visibleEditableColumns.map((column) => <FormField key={column.key} label={column.label} hint={Object.prototype.hasOwnProperty.call(detail.columnEdits, column.key) ? '已修改内容' : '原始内容'} className={visibleEditableColumns.length === 1 ? 'span-2' : ''}><Input value={draft.columns[column.key] ?? ''} onChange={(event) => setDraft((current) => ({ ...current, columns: { ...current.columns, [column.key]: event.target.value } }))} disabled={isReadOnly} autoComplete="off" /></FormField>)}</div></div>}
          {editableColumns.some((column) => isSensitiveColumn(kind, detail, column)) && !revealed && <div className="workbook-sensitive-edit-hint"><ShieldCheck size={14} /><span>请先查看敏感信息，再修改链接或口令。</span></div>}
          {canSave && <FormField label="更新原因" required><Textarea rows={2} value={draft.reason} onChange={(event) => setDraft((current) => ({ ...current, reason: event.target.value }))} disabled={isReadOnly} placeholder="填写更新原因" /></FormField>}
          {error && <div className={`notice ${conflict ? 'notice-warning' : 'notice-error'}`} role="alert">{error}</div>}
          <div className="modal-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>{canSave && <Button type="submit" disabled={saving || loading || isReadOnly}>{saving ? '保存中…' : '保存修改'}</Button>}</div>
        </section>
      </form>

      {detail.auditEvents.length > 0 && <section className="workbook-detail-section workbook-audit-section"><div className="workbook-detail-section-heading"><div><h3>修改记录</h3></div></div><div className="workbook-audit-list">{detail.auditEvents.map((event) => <article key={event.id}><time>{formatDateTime(event.occurredAt)}</time><span>{event.changedFields.map((field) => fieldLabel(field, detail.columns)).join('、')}</span><p>{event.reason}</p></article>)}</div></section>}
    </div> : <div className="notice notice-error" role="alert">{error || '记录详情暂时无法加载。'}<Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>关闭</Button></div>}
  </Modal>;
}

function fieldLabel(field: string, columns: WorkbookRowDetail['columns']) {
  if (field.startsWith('column:')) {
    const key = field.slice('column:'.length);
    return columns.find((column) => column.key === key)?.label ?? '来源列';
  }
  const labels: Record<string, string> = {
    coordinationStatus: '协作状态', collaborationNote: '协作备注', nextAction: '下一步行动', nextActionDueAt: '下一步期限',
  };
  return labels[field] ?? field;
}


type ManualFieldGroup = 'object' | 'product' | 'terms';

function manualFieldGroup(label: string, kind: WorkbookKind): ManualFieldGroup {
  if (kind === 'samples' && /(收件|收货人|联系人|地址|电话)/u.test(label)) return 'terms';
  if (/(平台|达人|账号|UID|商务|填表日期)/u.test(label)) return 'object';
  if (/(产品|商品|规格|数量|SKU)/u.test(label)) return 'product';
  return 'terms';
}

function manualInputType(label: string): 'text' | 'tel' | 'number' | 'date' | 'textarea' {
  if (/电话/u.test(label)) return 'tel';
  if (/填表日期|日期/u.test(label)) return 'date';
  if (/数量|佣金|价格|金额/u.test(label)) return 'number';
  if (/地址|要求|备注|机制|模式|说明|约定/u.test(label)) return 'textarea';
  return 'text';
}

const platformSourceDefaults: Partial<Record<WorkbookPlatform, string>> = {
  douyin: '抖音', channels: '视频号', xiaohongshu: '小红书', kuaishou: '快手',
};

function ManualCreateDialog({ kind, workbook, sheets, role, preferredSheetName, platform, onOpenChange, onCreated }: {
  kind: WorkbookKind;
  workbook: WorkbookContext;
  sheets: WorkbookSummary['sheets'];
  role: string;
  preferredSheetName: string;
  platform: WorkbookPlatform | '';
  onOpenChange: (open: boolean) => void;
  onCreated: (row: WorkbookRowDetail) => void;
}) {
  const initialSheet = sheets.find((sheet) => sheet.sheetName === preferredSheetName) ?? sheets[0];
  const [templateKey, setTemplateKey] = useState(initialSheet ? `${initialSheet.sourceSha256}:${initialSheet.sheetName}` : '');
  const [values, setValues] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const currentSheet = sheets.find((sheet) => `${sheet.sourceSha256}:${sheet.sheetName}` === templateKey) ?? null;
  const columns = currentSheet?.columns.filter((column) => currentSheet.manualCreateColumnKeys.includes(column.key)) ?? [];
  const requiredKeys = new Set(currentSheet?.requiredManualCreateColumnKeys ?? []);
  const sections: Array<{ id: ManualFieldGroup; title: string; hint: string }> = kind === 'samples'
    ? [
      { id: 'object', title: '达人资料', hint: '记录平台、达人和账号信息。商务归属按成员设置确定。' },
      { id: 'product', title: '寄样商品', hint: '填写本次需求涉及的商品和数量。' },
      { id: 'terms', title: '收件信息与寄样约定', hint: '补充收件资料、寄样类型、合作模式和其他要求。' },
    ]
    : [
      { id: 'object', title: '达人资料', hint: '登记平台、达人和账号信息。' },
      { id: 'product', title: '上播产品', hint: '登记准备设置的直播产品。' },
      { id: 'terms', title: '设置要求', hint: '填写直播机制、佣金和其他要求。' },
    ];

  useEffect(() => {
    if (!currentSheet) { setValues({}); return; }
    const platformColumn = columns.find((column) => column.label === '平台');
    setValues(platformColumn && platform ? { [platformColumn.key]: platformSourceDefaults[platform] ?? '' } : {});
    setReason('');
    setError('');
  // Changing templates starts a separate empty record; platform tab only supplies a safe exact-label default.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateKey, platform]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if (!currentSheet) { setError('请选择资料表。'); return; }
    if (!reason.trim()) { setError('请填写本次录入原因。'); return; }
    const missing = columns.filter((column) => requiredKeys.has(column.key) && !(values[column.key] ?? '').trim());
    if (missing.length) { setError(`请填写必填字段：${missing.map((column) => column.label).join('、')}。`); return; }
    const cells: Record<string, WorkbookCell> = {};
    for (const column of columns) {
      const value = values[column.key] ?? '';
      if (!value.trim()) { cells[column.key] = null; continue; }
      if (manualInputType(column.label) === 'number') {
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || numeric < 0) { setError(`${column.label}必须是有效的非负数字。`); return; }
        cells[column.key] = numeric;
      } else cells[column.key] = value;
    }
    setSaving(true);
    try {
      const created = await createWorkbookRow({ templateSourceSha256: currentSheet.sourceSha256, sheetName: currentSheet.sheetName, cells, reason: reason.trim() }, workbook);
      toast.success(kind === 'samples' ? '寄样需求已登记' : '上播设置已登记');
      onCreated(created);
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '登记失败，请重试。');
    } finally {
      setSaving(false);
    }
  }

  return <Modal open onOpenChange={onOpenChange} title={kind === 'samples' ? '新建寄样需求' : '登记上播设置'} description={kind === 'samples' ? '登记达人寄样申请。' : '登记达人上播设置。'} className="modal-wide workbook-manual-create-drawer translate-x-0 translate-y-0">
    <form className="workbook-create-form" onSubmit={submit}>
      {sheets.length > 1 && <div className="workbook-create-header"><FormField label="资料表" hint="切换资料表会清空当前填写内容。"><select className="native-select" value={templateKey} onChange={(event) => setTemplateKey(event.target.value)}>{sheets.map((sheet) => <option key={`${sheet.sourceSha256}:${sheet.sheetName}`} value={`${sheet.sourceSha256}:${sheet.sheetName}`}>{sheet.sheetName} · {sheet.year ?? '未标年份'}</option>)}</select></FormField></div>}
      {!currentSheet || columns.length === 0 ? <EmptyState title="暂时不能新增记录" description="请联系管理员。" /> : <>
        <div className="workbook-create-privacy"><ShieldCheck size={14} /><span>收件信息和链接仅向相关岗位开放；{role === 'local_bd' ? '商务归属由成员设置，不能在这里修改。' : '请选择已有的商务名称。'}</span></div>
        {sections.map((section) => {
          const groupColumns = columns.filter((column) => manualFieldGroup(column.label, kind) === section.id);
          if (!groupColumns.length) return null;
          return <section className="workbook-create-section" key={section.id} aria-labelledby={`create-${section.id}`}>
            <div className="workbook-create-section-title"><span>{sections.findIndex((item) => item.id === section.id) + 1}</span><div><h3 id={`create-${section.id}`}>{section.title}</h3><p>{section.hint}</p></div></div>
            <div className="workbook-create-grid">{groupColumns.map((column) => {
              const required = requiredKeys.has(column.key);
              const type = manualInputType(column.label);
              const isOwnerField = role === 'local_manager' && /(商务|负责人)/u.test(column.label);
              if (isOwnerField) return <FormField key={column.key} label={column.label} required={required}><select className="native-select" value={values[column.key] ?? ''} onChange={(event) => setValues((current) => ({ ...current, [column.key]: event.target.value }))} required={required}><option value="">不指定</option>{currentSheet.businessOwners.map((owner) => <option value={owner} key={owner}>{owner}</option>)}</select></FormField>;
              if (type === 'textarea') return <FormField key={column.key} label={column.label} required={required} className="span-2"><Textarea rows={column.label.includes('地址') ? 2 : 3} value={values[column.key] ?? ''} onChange={(event) => setValues((current) => ({ ...current, [column.key]: event.target.value }))} required={required} placeholder={`填写${column.label}`} /></FormField>;
              return <FormField key={column.key} label={column.label} required={required} hint={column.label === '平台' ? '按实际平台填写。' : undefined}><Input type={type} min={type === 'number' ? 0 : undefined} step={type === 'number' ? 'any' : undefined} value={values[column.key] ?? ''} onChange={(event) => setValues((current) => ({ ...current, [column.key]: event.target.value }))} required={required} autoComplete="off" placeholder={column.label === '平台' ? '抖音 / 视频号 / 小红书 / 快手 / 其他' : `填写${column.label}`} /></FormField>;
            })}</div>
          </section>;
        })}
        <FormField label="录入原因" required><Textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} required placeholder="例如：已确认合作意向，开始准备寄样" /></FormField>
      </>}
      {error && <div className="notice notice-error" role="alert">{error}</div>}
      <div className="workbook-create-footer"><Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button><Button type="submit" disabled={saving || !currentSheet || columns.length === 0}>{saving ? '正在登记…' : kind === 'samples' ? '确认寄样需求' : '登记设置需求'}</Button></div>
    </form>
  </Modal>;
}
