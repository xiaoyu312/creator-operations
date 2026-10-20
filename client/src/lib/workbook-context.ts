import type { SessionResponse, WorkbookWorkspaceSession } from '../../../shared/http.ts';
import type { LocalWorkbookActor, WorkbookListFilters } from '../../../shared/workbook.ts';

type LocalWorkbookSession = NonNullable<SessionResponse['localWorkbook']> & {
  principalId: string;
  storage: 'local';
  brandId: null;
  brandName: string;
};

type CloudWorkbookSession = Omit<WorkbookWorkspaceSession, 'brandId' | 'brandName' | 'storage'> & {
  principalId: string;
  storage: 'cloud' | 'local';
  brandId: string;
  brandName: string;
};

export type WorkbookContext = CloudWorkbookSession | LocalWorkbookSession;

export function getWorkbookContext(session: SessionResponse | undefined | null): WorkbookContext | null {
  if (!session) return null;
  if (session.businessWorkspace && session.workbook) return {
    ...session.workbook,
    principalId: session.actor.principalId,
    storage: session.businessWorkspace.storage,
    brandId: session.businessWorkspace.brandId,
    brandName: session.businessWorkspace.brandName,
  };
  if (session.workbook?.brandId && ((session.dataMode === 'production' && session.workbook.storage === 'cloud')
    || (session.dataMode === 'local' && session.workbook.storage === 'local'))) return {
    ...session.workbook,
    principalId: session.actor.principalId,
    storage: session.workbook.storage,
    brandId: session.workbook.brandId,
    brandName: session.workbook.brandName || session.workbook.label || '当前品牌',
  };
  if (session.dataMode !== 'local' || !session.localWorkbook) return null;
  return {
    ...session.localWorkbook,
    principalId: session.actor.principalId,
    storage: 'local',
    brandId: null,
    brandName: session.localWorkbook.label || '来源品牌',
  };
}

export function isWorkbook(session: SessionResponse | undefined | null): boolean {
  return !isBusinessWorkspace(session) && getWorkbookContext(session) !== null;
}

export function isBusinessWorkspace(session: SessionResponse | undefined | null): boolean {
  return Boolean(session?.businessWorkspace?.brandId);
}

export function workbookRole(context: WorkbookContext | null): LocalWorkbookActor['role'] | '' {
  return context?.role ?? '';
}

export function canPreviewLocalRole(session: SessionResponse | undefined | null): boolean {
  if (session?.businessWorkspace?.storage === 'local') return session.businessWorkspace.rolePreview === true;
  return session?.dataMode === 'local' && session.localWorkbook?.rolePreview === true;
}

export function workbookQueryKey(kind: string, context: WorkbookContext, ...parts: unknown[]) {
  const permissionScope = [context.principalId, context.role ?? 'local_manager', context.businessOwnerName?.trim() ?? ''];
  const scope = context.brandId
    ? [context.storage, context.brandId, context.sourceSha256, ...permissionScope]
    : ['local', context.sourceSha256, ...permissionScope];
  return ['workbook', kind, ...scope, ...parts] as const;
}

/** Summary keys represent the filters that affect the aggregate response, not the page using it. */
export function workbookSummaryQueryKey(context: WorkbookContext, filters: WorkbookListFilters = {}) {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (key === 'page' || key === 'pageSize' || value === undefined || value === null || value === '') continue;
    normalized[key] = value;
  }
  if (typeof filters.query === 'string') {
    const query = filters.query.trim();
    if (query) normalized.query = query;
    else delete normalized.query;
  }
  normalized.includeHidden = filters.includeHidden ?? false;
  const canonicalFilters = Object.fromEntries(Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)));
  return workbookQueryKey('summary', context, canonicalFilters);
}

export function brandNavigationUrl(currentUrl: string, brandId: string): string {
  const url = new URL(currentUrl);
  url.searchParams.set('brandId', brandId);
  return `${url.pathname}${url.search}${url.hash}`;
}
