import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveWorkbookSourceMetadata,
  visibleWorkbookHistoryKinds,
  workbookHistoryHref,
  workbookHistoryPath,
} from '../client/src/lib/workbook-route.ts';
import { workbookSummaryQueryKey } from '../client/src/lib/workbook-context.ts';

test('history destinations use source-record routes only in the native business workspace', () => {
  assert.equal(workbookHistoryPath(true, 'samples'), '/source-records/samples');
  assert.equal(workbookHistoryPath(true, 'broadcast'), '/source-records/broadcast');
  assert.equal(workbookHistoryPath(true, 'data-screen'), '/source-records/data-screen');
  assert.equal(workbookHistoryPath(false, 'samples'), '/samples');
  assert.equal(workbookHistoryPath(false, 'broadcast'), '/schedule');
  assert.equal(workbookHistoryPath(false, 'data-screen'), '/data-screen');
});

test('history links retain brand, platform, year, and optional queue filters', () => {
  assert.equal(
    workbookHistoryHref({
      nativeBusiness: true,
      target: 'samples',
      platform: 'douyin',
      year: 2025,
      brandId: 'brand-a',
      extra: { fieldState: 'tracking_missing' },
    }),
    '/source-records/samples?brandId=brand-a&platform=douyin&year=2025&fieldState=tracking_missing',
  );
  assert.equal(
    workbookHistoryHref({ nativeBusiness: false, target: 'home', platform: '', year: null, brandId: null }),
    '/?year=all',
  );
  assert.equal(
    workbookHistoryHref({ nativeBusiness: true, target: 'home', platform: '', year: 2026, brandId: 'brand-a' }),
    '/source-records?brandId=brand-a&year=2026',
  );
});

test('history entry visibility follows the selected workbook role', () => {
  assert.deepEqual(visibleWorkbookHistoryKinds('local_manager'), ['samples', 'broadcast']);
  assert.deepEqual(visibleWorkbookHistoryKinds('local_bd'), ['samples', 'broadcast']);
  assert.deepEqual(visibleWorkbookHistoryKinds('local_shipping'), ['samples']);
  assert.deepEqual(visibleWorkbookHistoryKinds('local_links'), ['broadcast']);
  assert.deepEqual(visibleWorkbookHistoryKinds('manager'), ['samples', 'broadcast']);
  assert.deepEqual(visibleWorkbookHistoryKinds('shipping'), ['samples']);
});

test('empty session source metadata falls back to readable summary metadata', () => {
  assert.deepEqual(resolveWorkbookSourceMetadata(
    { sourceFileName: '', readAt: '' },
    [
      { sourceFileName: 'empty-template.xlsx', sourceSha256: 'template', rowCount: 0, readAt: '2026-03-01T00:00:00Z' },
      { sourceFileName: 'source.xlsx', sourceSha256: 'source', rowCount: 12, readAt: '2026-02-01T00:00:00Z' },
    ],
  ), { sourceFileName: 'source.xlsx', readAt: '2026-02-01T00:00:00Z' });
  assert.deepEqual(resolveWorkbookSourceMetadata(
    { sourceFileName: '', sourceSha256: 'template', readAt: '' },
    [
      { sourceFileName: 'empty-template.xlsx', sourceSha256: 'template', rowCount: 0, readAt: '2026-03-01T00:00:00Z' },
      { sourceFileName: 'source.xlsx', sourceSha256: 'source', rowCount: 12, readAt: '2026-02-01T00:00:00Z' },
    ],
  ), { sourceFileName: 'empty-template.xlsx', readAt: '2026-03-01T00:00:00Z' });
  assert.deepEqual(resolveWorkbookSourceMetadata({ sourceFileName: '  ', readAt: '  ' }, []), {
    sourceFileName: '暂无资料文件',
    readAt: null,
  });
});

test('summary cache keys reuse matching year and platform filters', () => {
  const workbook = {
    principalId: 'principal-a',
    storage: 'cloud' as const,
    brandId: 'brand-a',
    brandName: '品牌 A',
    label: '品牌 A',
    sourceFileName: '',
    sourceSha256: 'source-a',
    readAt: '',
    role: 'local_manager' as const,
    businessOwnerName: null,
    availableBusinessOwners: [],
    rolePreview: false,
  };
  const catalog = workbookSummaryQueryKey(workbook, { sourceSha256: 'source-a' });
  const allYears = workbookSummaryQueryKey(workbook, { sourceSha256: 'source-a' });
  const yearScoped = workbookSummaryQueryKey(workbook, { sourceSha256: 'source-a', year: 2026 });
  const sameYearPlatformScope = workbookSummaryQueryKey(workbook, { sourceSha256: 'source-a', year: 2026 });
  const selectedPlatform = workbookSummaryQueryKey(workbook, { sourceSha256: 'source-a', year: 2026, platform: 'douyin' });

  assert.deepEqual(catalog, allYears, 'all-year catalog and summary queries share a cache key');
  assert.deepEqual(yearScoped, sameYearPlatformScope, 'unfiltered and platform-scope queries share a year-only key');
  assert.notDeepEqual(selectedPlatform, sameYearPlatformScope, 'selected-platform totals retain a separate all-platform year query');
});
