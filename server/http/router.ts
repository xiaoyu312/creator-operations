import { ZodError } from 'zod';
import { DomainError } from '../domain/errors.ts';
import type { DaboApiService } from '../modules/dabo/dabo-api.service.ts';
import type { Request, Response } from './contracts.ts';

export interface ApiRequest extends Request {
  method: string;
  /** Origin-form path only, as supplied by the local Node HTTP adapter. */
  url: string;
  body?: unknown;
}
export interface ApiResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** The routes and return shapes of the original DaboController. No socket opens here. */
export function createApiRouter(service: DaboApiService) {
  return async (request: ApiRequest): Promise<ApiResult> => {
    const headers: Record<string, string> = {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    };
    const response: Response = {
      cookie(name, value, options) {
        headers['Set-Cookie'] = `${name}=${value}; Path=${options.path}; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(options.maxAge / 1000)}`;
      },
    };
    try {
      if (!request.url.startsWith('/') || request.url.startsWith('//')) {
        throw new DomainError('VALIDATION_ERROR', '请求路径无效。');
      }
      const url = new URL(request.url, 'http://127.0.0.1');
      const path = url.pathname;
      const query = Object.fromEntries(url.searchParams);
      let body: unknown;
      if (request.method === 'GET' && path === '/api/session') {
        body = await service.session(request, response);
      } else if (request.method === 'POST' && path === '/api/demo/session') {
        body = await service.selectDemo(request, response, request.body);
      } else if (request.method === 'GET' && path === '/api/workspace') {
        body = await service.workspace(request, query);
      } else if (request.method === 'POST' && path === '/api/commands') {
        body = await service.command(request, request.body);
      } else if (request.method === 'POST' && path === '/api/imports/preview') {
        body = await service.preview(request, request.body);
      } else if (request.method === 'POST' && path === '/api/imports/commit') {
        body = await service.commit(request, request.body);
      } else if (request.method === 'GET' && /^\/api\/imports\/template\/[^/]+$/u.test(path)) {
        const kind = path.split('/').at(-1)!;
        body = service.template(request, kind);
        headers['Content-Type'] = 'text/csv; charset=utf-8';
        headers['Content-Disposition'] = `attachment; filename="dabo-${kind}-template.csv"`;
      } else if (request.method === 'POST' && /^\/api\/exports\/[^/]+$/u.test(path)) {
        const kind = path.split('/').at(-1)!;
        body = await service.export(request, kind, request.body as Record<string, unknown>);
        headers['Content-Type'] = 'text/csv; charset=utf-8';
        headers['Content-Disposition'] = `attachment; filename="dabo-${kind}.csv"`;
      } else {
        throw new DomainError('NOT_FOUND', '此接口不在本地合成工作台中；平台品牌、工作簿和成员邀请适配默认未启用。');
      }
      return { status: 200, headers, body };
    } catch (error) {
      return { ...apiError(error), headers };
    }
  };
}

/** Preserve the original error contract without logging payloads or headers. */
export function apiError(error: unknown): Pick<ApiResult, 'status' | 'body'> {
  if (error instanceof DomainError) {
    const code = error.code;
    const status = code === 'UNAUTHENTICATED' ? 401 : code === 'FORBIDDEN' ? 403
      : code === 'NOT_FOUND' ? 404
        : ['VERSION_CONFLICT', 'IDENTITY_CONFLICT', 'DUPLICATE', 'IMPORT_CONFLICT'].includes(code) ? 409 : 422;
    return { status, body: { error: { code, message: error.message, details: error.details } } };
  }
  if (error instanceof ZodError) {
    return {
      status: 422,
      body: { error: { code: 'VALIDATION_ERROR', message: '输入不符合要求，请检查标记字段。',
        details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) } },
    };
  }
  return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用，操作未完成。请稍后重试。' } } };
}
