import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from '../../http/contracts.ts';
import type { Actor } from '../../../shared/types.ts';
import type { SessionResponse } from '../../../shared/http.ts';
import { DomainService } from '../../domain/domain-service.ts';
import { DomainError } from '../../domain/errors.ts';
import { parseRoleMapping, resolvePlatformActor, validatePlatformRoleMapping, type PlatformRoleMapping } from '../../runtime/config.ts';

export abstract class IdentityProvider {
  abstract readonly mode: 'demo' | 'production';
  abstract actor(request: Request): Actor;
  abstract session(request: Request, response: Response, domain: DomainService): Promise<SessionResponse>;
  abstract assertWrite(request: Request): void;
  async selectDemo(_request: Request, _response: Response, _domain: DomainService, _principalId: string): Promise<SessionResponse> {
    throw new DomainError('FORBIDDEN', '正式应用不提供演示身份切换。');
  }
}

export class PlatformIdentityProvider extends IdentityProvider {
  readonly mode = 'production' as const;
  private readonly mapping: PlatformRoleMapping;
  private readonly appId: string;

  constructor() {
    super();
    if (process.env.DABO_MODE === 'demo') throw new Error('正式启动入口禁止启用演示模式。');
    this.appId = process.env.DABO_EXPECTED_APP_ID ?? '';
    if (!/^app_[a-zA-Z0-9]+$/u.test(this.appId)) throw new Error('请先配置经核验的 DABO_EXPECTED_APP_ID。');
    this.mapping = parseRoleMapping(process.env.DABO_ROLE_MAPPING);
    validatePlatformRoleMapping(this.mapping);
  }

  actor(request: Request): Actor {
    return resolvePlatformActor(request.userContext, this.appId, this.mapping);
  }

  async session(request: Request, _response: Response, domain: DomainService): Promise<SessionResponse> {
    return { ...(await domain.getSession(this.actor(request))), appName: '达人协作工作台' };
  }

  assertWrite(_request: Request): void {
    // PlatformModule owns the production CSRF and authentication transports.
  }
}

interface DemoSession { principalId: string; csrf: string; expiresAt: number }

/** Isolated training harness. It is not registered by the production AppModule. */
export class DemoIdentityProvider extends IdentityProvider {
  readonly mode = 'demo' as const;
  private readonly sessions = new Map<string, DemoSession>();
  constructor(private readonly defaultPrincipalId: string) {
    super();
    if (process.env.NODE_ENV === 'production' || (process.env.DABO_MODE ?? 'demo') !== 'demo') {
      throw new Error('演示身份仅可由本地专用入口显式启动。');
    }
  }

  private checkLocalHost(request: Request): void {
    const host = request.headers.host?.split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') throw new DomainError('FORBIDDEN', '演示入口仅允许本机访问。');
  }

  private sessionId(request: Request): string | undefined {
    const cookie = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('dabo-demo='));
    return cookie?.slice('dabo-demo='.length);
  }

  private current(request: Request): DemoSession {
    this.checkLocalHost(request);
    const id = this.sessionId(request);
    const session = id ? this.sessions.get(id) : undefined;
    if (!session || session.expiresAt < Date.now()) {
      if (id) this.sessions.delete(id);
      throw new DomainError('UNAUTHENTICATED', '演示会话已过期，请刷新页面。');
    }
    return session;
  }

  actor(request: Request): Actor { return { principalId: this.current(request).principalId }; }

  private newSession(response: Response, principalId: string): DemoSession {
    for (const [key, value] of this.sessions) if (value.expiresAt < Date.now()) this.sessions.delete(key);
    if (this.sessions.size > 500) throw new DomainError('FORBIDDEN', '演示会话过多，请重启本地演示服务。');
    const id = randomBytes(32).toString('hex');
    const session = { principalId, csrf: randomBytes(24).toString('hex'), expiresAt: Date.now() + 12 * 60 * 60 * 1000 };
    this.sessions.set(id, session);
    response.cookie('dabo-demo', id, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 12 * 60 * 60 * 1000 });
    return session;
  }

  async session(request: Request, response: Response, domain: DomainService): Promise<SessionResponse> {
    this.checkLocalHost(request);
    let current: DemoSession;
    try { current = this.current(request); }
    catch { current = this.newSession(response, this.defaultPrincipalId); }
    return {
      ...(await domain.getSession({ principalId: current.principalId })),
      demoCsrfToken: current.csrf, appName: '达人协作工作台',
    };
  }

  assertWrite(request: Request): void {
    const session = this.current(request);
    const supplied = request.headers['x-dabo-csrf'];
    if (typeof supplied !== 'string' || supplied.length !== session.csrf.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(session.csrf))) {
      throw new DomainError('FORBIDDEN', '演示请求校验失败，请刷新页面后重试。');
    }
    const origin = request.headers.origin;
    if (origin) {
      let parsed: URL;
      try { parsed = new URL(origin); } catch { throw new DomainError('FORBIDDEN', '请求来源无效。'); }
      if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.protocol !== 'http:') {
        throw new DomainError('FORBIDDEN', '演示写入仅允许本机页面发起。');
      }
    }
  }

  override async selectDemo(request: Request, response: Response, domain: DomainService, principalId: string): Promise<SessionResponse> {
    this.assertWrite(request);
    const existing = await domain.getSession(this.actor(request));
    if (!existing.allowedDemoProfiles.some((profile) => profile.principalId === principalId)) {
      throw new DomainError('FORBIDDEN', '未知的演示身份。');
    }
    const previous = this.sessionId(request);
    if (previous) this.sessions.delete(previous);
    const session = this.newSession(response, principalId);
    return { ...(await domain.getSession({ principalId })), demoCsrfToken: session.csrf, appName: '达人协作工作台' };
  }
}
