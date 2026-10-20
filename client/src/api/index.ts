import type { DomainCommand } from '../../../shared/commands.ts';
import type { WorkbookBrand, WorkbookBrandCreateInput, WorkbookBrandMember, WorkbookBrandMemberInput, WorkbookBrandUpdateInput } from '../../../shared/brands.ts';
import type { CsvImportRequest, CsvKind, CsvPreviewResponse, ExportKind, LocalRoleSelection, SessionResponse } from '../../../shared/http.ts';
import type { DomainCommandResult, WorkspaceFilters, WorkspaceSnapshot } from '../../../shared/types.ts';
import type { ExecutiveDemoResponse } from '../../../shared/api.interface';
import type { ScenarioReadOnlyWorkspace } from '../../../shared/scenario-readonly.ts';
import type {
  CreateInvitationInput, CreatedInvitation, InvitationDirectory,
  InvitationJoinContext, InvitationJoinView, MemberInvitation,
} from '../../../shared/invitations.ts';

export function getScenarioReadOnlyWorkspace(): Promise<ScenarioReadOnlyWorkspace> {
  return requestJson<ScenarioReadOnlyWorkspace>('/api/scenario-readonly/workspace', 'GET');
}

export type ImportKind = CsvKind;

export interface ApiProblem {
  code: string;
  message: string;
  details?: unknown;
  loginUrl?: string;
}

export class ApiError extends Error {
  code: string;
  details?: unknown;
  loginUrl?: string;

  constructor(problem: ApiProblem) {
    super(problem.message);
    this.name = 'ApiError';
    this.code = problem.code;
    this.details = problem.details;
    this.loginUrl = problem.loginUrl;
  }
}

declare global {
  interface Window { csrfToken?: string }
}

let demoCsrfToken: string | undefined;
let businessBrandId: string | undefined;
export function getActiveBusinessBrandId(): string | undefined { return businessBrandId; }
function businessScope(brandId = businessBrandId): Record<string, string> | undefined {
  return brandId ? { brandId } : undefined;
}
const CLIENT_BASE_PATH = process.env.CLIENT_BASE_PATH || '/';

function withBasePath(path: string) {
  const base = CLIENT_BASE_PATH.replace(/\/+$/u, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalizedPath}` || '/';
}

function withQuery(path: string, params?: Record<string, unknown>) {
  if (!params) return path;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, String(value));
  }
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}

function csrfHeaders() {
  if (demoCsrfToken) return { 'X-Dabo-CSRF': demoCsrfToken };
  if (window.csrfToken) return { 'X-Suda-Csrf-Token': window.csrfToken };
  return {};
}

function safeLoginUrl(raw: string | null) {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw, window.location.origin);
    if (parsed.origin !== window.location.origin) return undefined;
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

async function readErrorBody(response: Response) {
  try { return await response.json() as { error?: { code?: string; message?: string; details?: unknown } }; }
  catch { return undefined; }
}

async function errorFromResponse(response: Response): Promise<ApiError> {
  const body = await readErrorBody(response);
  const serverError = body?.error;
  const statusCode = response.status === 401 ? 'UNAUTHENTICATED' : response.status === 403 ? 'FORBIDDEN' : undefined;
  const code = statusCode ?? serverError?.code ?? 'REQUEST_FAILED';
  const fallbackMessage = response.status === 401
    ? '登录状态已失效，请重新登录后继续。'
    : response.status === 403
      ? '当前账号没有执行此操作的权限。'
      : '请求失败，请稍后重试。';
  return new ApiError({
    code,
    message: serverError?.message ?? fallbackMessage,
    details: serverError?.details,
    loginUrl: response.status === 401 ? safeLoginUrl(response.headers.get('x-login-url')) : undefined,
  });
}

export async function requestJson<T>(path: string, method: 'GET' | 'POST', data?: unknown, params?: Record<string, unknown>): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  // Miaoda's gateway validates the platform CSRF header on reads as well.
  Object.assign(headers, csrfHeaders());
  const response = await fetch(withBasePath(withQuery(path, params)), {
    method,
    credentials: 'same-origin',
    headers,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok) {
    const error = await errorFromResponse(response);
    if (error.code === 'UNAUTHENTICATED') window.dispatchEvent(new CustomEvent('dabo:unauthenticated', { detail: { loginUrl: error.loginUrl } }));
    throw error;
  }
  if (response.status === 204) return undefined as T;
  try { return await response.json() as T; }
  catch { throw new ApiError({ code: 'INVALID_RESPONSE', message: '服务端返回内容无法读取，请刷新后重试。' }); }
}

async function requestBlob(path: string, method: 'GET' | 'POST' = 'GET', data?: unknown, params?: Record<string, unknown>): Promise<Blob> {
  const headers: Record<string, string> = { Accept: 'text/csv, application/octet-stream' };
  Object.assign(headers, csrfHeaders());
  if (method !== 'GET') {
    if (data !== undefined) headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(withBasePath(withQuery(path, params)), { method, credentials: 'same-origin', headers, body: data === undefined ? undefined : JSON.stringify(data) });
  if (!response.ok) {
    const error = await errorFromResponse(response);
    if (error.code === 'UNAUTHENTICATED') window.dispatchEvent(new CustomEvent('dabo:unauthenticated', { detail: { loginUrl: error.loginUrl } }));
    throw error;
  }
  return response.blob();
}

export async function getSession(brandId?: string): Promise<SessionResponse> {
  const session = await requestJson<SessionResponse>('/api/session', 'GET', undefined, brandId ? { brandId } : undefined);
  businessBrandId = session.businessWorkspace?.brandId ?? session.workbook?.brandId ?? undefined;
  demoCsrfToken = session.dataMode === 'demo' ? session.demoCsrfToken : session.dataMode === 'local' || session.businessWorkspace?.storage === 'local' ? session.localCsrfToken : undefined;
  return session;
}

export function listMemberInvitations(): Promise<InvitationDirectory> {
  return requestJson('/api/member-invitations', 'GET');
}

export function createMemberInvitation(input: CreateInvitationInput): Promise<CreatedInvitation> {
  return requestJson('/api/member-invitations', 'POST', input);
}

export function revokeMemberInvitation(id: string, expectedVersion: number): Promise<MemberInvitation> {
  return requestJson(`/api/member-invitations/${encodeURIComponent(id)}/revoke`, 'POST', { expectedVersion });
}

export function approveMemberInvitation(id: string, expectedVersion: number): Promise<MemberInvitation> {
  return requestJson(`/api/member-invitations/${encodeURIComponent(id)}/approve`, 'POST', {
    expectedVersion, confirmIdentity: true,
  });
}

export function recoverMemberInvitation(id: string, expectedVersion: number): Promise<MemberInvitation> {
  return requestJson(`/api/member-invitations/${encodeURIComponent(id)}/recover`, 'POST', { expectedVersion });
}

export async function getInvitationJoinContext(): Promise<InvitationJoinContext> {
  const context = await requestJson<InvitationJoinContext>('/api/member-invitations/join-context', 'GET');
  demoCsrfToken = context.localPreview ? context.csrfToken : undefined;
  return context;
}

export function inspectMemberInvitation(token: string): Promise<InvitationJoinView> {
  return requestJson('/api/member-invitations/inspect', 'POST', { token });
}

export function claimMemberInvitation(token: string): Promise<InvitationJoinView> {
  return requestJson('/api/member-invitations/claim', 'POST', { token });
}

export function memberInvitationUrl(invitationPath: string): string {
  if (!/^\/join#invite=[A-Za-z0-9_-]{43}$/u.test(invitationPath)) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: '邀请链接无效，请重新生成。' });
  }
  return new URL(withBasePath(invitationPath), window.location.origin).href;
}

export async function switchDemoProfile(principalId: string): Promise<SessionResponse> {
  const session = await requestJson<SessionResponse>('/api/demo/session', 'POST', { principalId });
  demoCsrfToken = session.dataMode === 'demo' ? session.demoCsrfToken : undefined;
  return session;
}

export async function switchLocalRole(selection: LocalRoleSelection): Promise<SessionResponse> {
  const session = await requestJson<SessionResponse>('/api/local-role', 'POST', selection, businessScope());
  businessBrandId = session.businessWorkspace?.brandId ?? session.workbook?.brandId ?? undefined;
  demoCsrfToken = session.dataMode === 'local' || session.businessWorkspace?.storage === 'local' ? session.localCsrfToken : undefined;
  return session;
}

export async function getWorkspace(filters: WorkspaceFilters = {}, brandId: string | undefined = businessBrandId): Promise<WorkspaceSnapshot> {
  return requestJson<WorkspaceSnapshot>('/api/workspace', 'GET', undefined, { includeClosed: true, ...filters, ...(brandId ? { brandId } : {}) });
}

export async function listWorkbookBrands(): Promise<{ brands: WorkbookBrand[]; canManageBrands: boolean }> {
  return requestJson<{ brands: WorkbookBrand[]; canManageBrands: boolean }>('/api/workbook/brands', 'GET');
}

export async function createWorkbookBrand(input: WorkbookBrandCreateInput): Promise<WorkbookBrand> {
  return requestJson<WorkbookBrand>('/api/workbook/brands', 'POST', input);
}

export async function createExecutiveDemo(): Promise<ExecutiveDemoResponse> {
  return requestJson<ExecutiveDemoResponse>('/api/demo/brands', 'POST', {});
}

export async function updateWorkbookBrand(brandId: string, input: WorkbookBrandUpdateInput): Promise<WorkbookBrand> {
  return requestJson<WorkbookBrand>(`/api/workbook/brands/${encodeURIComponent(brandId)}`, 'POST', input);
}

export async function listWorkbookBrandMembers(brandId: string): Promise<{ members: WorkbookBrandMember[] }> {
  return requestJson<{ members: WorkbookBrandMember[] }>(`/api/workbook/brands/${encodeURIComponent(brandId)}/members`, 'GET');
}

export async function upsertWorkbookBrandMember(brandId: string, input: WorkbookBrandMemberInput): Promise<WorkbookBrandMember> {
  return requestJson<WorkbookBrandMember>(`/api/workbook/brands/${encodeURIComponent(brandId)}/members`, 'POST', input);
}

export async function executeCommand(command: DomainCommand, brandId?: string): Promise<DomainCommandResult> {
  return requestJson<DomainCommandResult>('/api/commands', 'POST', command, businessScope(brandId));
}

export async function previewCsvImport(input: CsvImportRequest): Promise<CsvPreviewResponse> {
  return requestJson<CsvPreviewResponse>('/api/imports/preview', 'POST', input, businessScope());
}

export async function commitCsvImport(input: CsvImportRequest & { previewHash: string }): Promise<DomainCommandResult> {
  return requestJson<DomainCommandResult>('/api/imports/commit', 'POST', input, businessScope());
}

export async function downloadCsvExport(kind: ExportKind, filters: WorkspaceFilters = {}): Promise<Blob> {
  return requestBlob(`/api/exports/${kind}`, 'POST', filters, businessScope());
}

export async function downloadCsvTemplate(kind: ImportKind): Promise<Blob> {
  return requestBlob(`/api/imports/template/${kind}`, 'GET', undefined, businessScope());
}
