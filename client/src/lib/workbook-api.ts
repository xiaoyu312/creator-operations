import type {
  WorkbookListFilters,
  WorkbookListResult,
  WorkbookRecordSelector,
  WorkbookRowCreateInput,
  WorkbookRowDetail,
  WorkbookRowUpdateInput,
  WorkbookSummary,
} from '../../../shared/workbook.ts';
import type { WorkbookContext } from './workbook-context.ts';
import { requestJson } from '../api/index.ts';

export type {
  WorkbookListFilters,
  WorkbookListResult,
  WorkbookManualRecord,
  WorkbookRecordSelector,
  WorkbookRowDetail,
  WorkbookRowListItem,
  WorkbookRowCreateInput,
  WorkbookRowUpdateInput,
  WorkbookSummary,
} from '../../../shared/workbook.ts';

function endpoint(name: 'summary' | 'rows' | 'row', context: WorkbookContext) {
  return context.brandId ? `/api/workbook/${name}` : `/api/local-workbook/${name}`;
}

function scopedParams(params: Record<string, unknown>, context: WorkbookContext) {
  if (context.storage === 'local' && !context.brandId) return params;
  if (!context.brandId) throw new Error('当前品牌未就绪，请先选择或创建品牌。');
  return { ...params, brandId: context.brandId };
}

export function getWorkbookSummary(filters: WorkbookListFilters = {}, context: WorkbookContext): Promise<WorkbookSummary> {
  return requestJson<WorkbookSummary>(endpoint('summary', context), 'GET', undefined, scopedParams({ ...filters }, context));
}

export function listWorkbookRows(filters: WorkbookListFilters = {}, context: WorkbookContext): Promise<WorkbookListResult> {
  return requestJson<WorkbookListResult>(endpoint('rows', context), 'GET', undefined, scopedParams({ ...filters }, context));
}

export function getWorkbookRowDetail(selector: WorkbookRecordSelector, context: WorkbookContext, includeSensitive = false): Promise<WorkbookRowDetail> {
  return requestJson<WorkbookRowDetail>(endpoint('row', context), 'GET', undefined, scopedParams({ ...selector, includeSensitive }, context));
}

export function createWorkbookRow(input: WorkbookRowCreateInput, context: WorkbookContext): Promise<WorkbookRowDetail> {
  const path = context.brandId ? '/api/workbook/rows' : '/api/local-workbook/rows';
  return requestJson<WorkbookRowDetail>(path, 'POST', input, scopedParams({}, context));
}

export function updateWorkbookRow(input: WorkbookRowUpdateInput, context: WorkbookContext): Promise<WorkbookRowDetail> {
  return requestJson<WorkbookRowDetail>(endpoint('row', context), 'POST', input, scopedParams({}, context));
}
