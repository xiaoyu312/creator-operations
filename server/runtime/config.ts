import { z } from 'zod';
import type { Actor, Capability, Role } from '../../shared/types.ts';
import { CAPABILITIES, ROLES } from '../../shared/types.ts';
import { DomainError } from '../domain/errors.ts';

const roleIds = z.array(z.string().trim().min(1).max(200)).max(30);
const mappingSchema = z.object({
  roles: z.object({ admin: roleIds, manager: roleIds, bd: roleIds, ops: roleIds }).strict(),
  capabilities: z.object({
    'sample.approve': roleIds,
    'sample.fulfill': roleIds,
    'cooperation.approve': roleIds,
    'import.manage': roleIds,
    'audit.read': roleIds,
    'export.run': roleIds,
  }).strict(),
}).strict();

export type PlatformRoleMapping = z.infer<typeof mappingSchema>;
export interface PlatformIdentityContext {
  userId?: string;
  appId?: string;
  roles?: string[];
}

export function parseRoleMapping(raw: string | undefined): PlatformRoleMapping {
  if (!raw) {
    throw new DomainError('FORBIDDEN', '尚未配置经核验的妙搭角色映射，请由管理员完成应用接入。');
  }
  try {
    return mappingSchema.parse(JSON.parse(raw));
  } catch {
    throw new DomainError('FORBIDDEN', '妙搭角色映射配置无效，请联系应用管理员。');
  }
}

export function resolvePlatformActor(
  context: PlatformIdentityContext | undefined,
  expectedAppId: string | undefined,
  mapping: PlatformRoleMapping,
): Actor {
  if (!expectedAppId || !context?.userId || context.appId !== expectedAppId) {
    throw new DomainError('UNAUTHENTICATED', '登录身份或应用绑定尚未核验。');
  }
  // IDs are I64 strings. Never convert them to JavaScript numbers.
  if (!/^\d{1,30}$/.test(context.userId)) {
    throw new DomainError('UNAUTHENTICATED', '无效的妙搭用户身份。');
  }
  if (context.roles === undefined) {
    return { principalId: context.userId, platformAccess: { role: null, capabilities: [], sourceRoleState: 'missing' } };
  }
  if (!Array.isArray(context.roles) || context.roles.some((id) => typeof id !== 'string')) {
    throw new DomainError('UNAUTHENTICATED', '当前请求的角色上下文无效。');
  }
  const supplied = new Set(context.roles);
  const precedence: Role[] = ['admin', 'manager', 'bd', 'ops'];
  const role = precedence.find((candidate) => mapping.roles[candidate].some((id) => supplied.has(id))) ?? null;
  const capabilities: Capability[] = CAPABILITIES.filter((capability) =>
    mapping.capabilities[capability].some((id) => supplied.has(id)),
  );
  return { principalId: context.userId, platformAccess: { role, capabilities, sourceRoleState: 'present' } };
}

export function validatePlatformRoleMapping(mapping: PlatformRoleMapping): void {
  for (const role of ['admin', 'bd'] as const) {
    if (mapping.roles[role].length === 0) {
      throw new DomainError('FORBIDDEN', `角色 ${role} 尚未绑定经核验的平台标识。`);
    }
  }
}
