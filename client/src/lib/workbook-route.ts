import type { WorkbookSourceSummary, WorkbookPlatform } from '../../../shared/workbook.ts';

export type WorkbookHistoryKind = 'samples' | 'broadcast';
export type WorkbookHistoryTarget = WorkbookHistoryKind | 'data-screen' | 'home';
export type WorkbookHistoryRole =
  | 'local_manager' | 'local_bd' | 'local_shipping' | 'local_links'
  | 'manager' | 'bd' | 'shipping' | 'links';

const nativePaths: Record<WorkbookHistoryTarget, string> = {
  samples: '/source-records/samples',
  broadcast: '/source-records/broadcast',
  'data-screen': '/source-records/data-screen',
  home: '/source-records',
};

const workbookPaths: Record<WorkbookHistoryTarget, string> = {
  samples: '/samples',
  broadcast: '/schedule',
  'data-screen': '/data-screen',
  home: '/',
};

export function workbookHistoryPath(nativeBusiness: boolean, target: WorkbookHistoryTarget) {
  return (nativeBusiness ? nativePaths : workbookPaths)[target];
}

export function workbookHistoryHref(options: {
  nativeBusiness: boolean;
  target: WorkbookHistoryTarget;
  platform?: WorkbookPlatform | '';
  year: number | null;
  brandId?: string | null;
  extra?: Record<string, string>;
}) {
  const params = new URLSearchParams();
  if (options.brandId) params.set('brandId', options.brandId);
  if (options.platform) params.set('platform', options.platform);
  params.set('year', options.year === null ? 'all' : String(options.year));
  Object.entries(options.extra ?? {}).forEach(([key, value]) => params.set(key, value));
  const query = params.toString();
  return `${workbookHistoryPath(options.nativeBusiness, options.target)}${query ? `?${query}` : ''}`;
}

export function visibleWorkbookHistoryKinds(role: WorkbookHistoryRole): WorkbookHistoryKind[] {
  if (role === 'local_shipping' || role === 'shipping') return ['samples'];
  if (role === 'local_links' || role === 'links') return ['broadcast'];
  if (role === 'local_manager' || role === 'local_bd' || role === 'manager' || role === 'bd') return ['samples', 'broadcast'];
  return [];
}

function nonEmpty(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function resolveWorkbookSourceMetadata(
  profile: { sourceFileName?: string | null; sourceSha256?: string | null; readAt?: string | null },
  sources: readonly Pick<WorkbookSourceSummary, 'sourceFileName' | 'sourceSha256' | 'readAt' | 'rowCount'>[],
) {
  const explicitSource = nonEmpty(profile.sourceSha256)
    ? sources.find((source) => source.sourceSha256 === profile.sourceSha256)
    : undefined;
  const selectedSource = explicitSource ?? sources.find((source) => source.rowCount > 0) ?? sources[0];
  return {
    sourceFileName: nonEmpty(profile.sourceFileName)
      ?? nonEmpty(selectedSource?.sourceFileName)
      ?? sources.map((source) => nonEmpty(source.sourceFileName)).find(Boolean)
      ?? '暂无资料文件',
    readAt: nonEmpty(profile.readAt)
      ?? nonEmpty(selectedSource?.readAt)
      ?? sources.map((source) => nonEmpty(source.readAt)).find(Boolean)
      ?? null,
  };
}
