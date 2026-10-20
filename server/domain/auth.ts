import { CAPABILITIES, type Actor, type Capability, type DomainState, type Member, type Role, type Scoped } from "../../shared/types.ts";
import { domainError } from "./errors.ts";

export interface AuthContext {
  member: Member;
  role: Role;
  capabilities: Capability[];
}

export function resolveAuth(state: DomainState, actor: Actor): AuthContext {
  if (!actor || typeof actor.principalId !== "string" || actor.principalId.trim().length === 0) {
    domainError("UNAUTHENTICATED", "缺少可信平台身份");
  }
  const matches = state.members.filter((item) => item.principalId === actor.principalId && item.orgId === state.orgId);
  if (matches.length !== 1 || !matches[0].active) domainError("UNAUTHENTICATED", "平台身份未映射到有效的业务成员");
  const member = matches[0];
  const team = state.teams.find((item) => item.id === member.teamId && item.orgId === state.orgId && item.active);
  if (!team) domainError("FORBIDDEN", "成员当前没有可访问的有效团队");

  if (state.dataMode === "production") {
    const access = actor.platformAccess;
    if (!access || access.sourceRoleState === "missing") domainError("UNAUTHENTICATED", "可信平台角色上下文缺失");
    if (access.sourceRoleState !== "present") domainError("UNAUTHENTICATED", "可信平台角色上下文状态无效");
    if (access.role === null) domainError("FORBIDDEN", "平台角色未映射到本应用业务角色");
    if (!Array.isArray(access.capabilities) || access.capabilities.some((item) => !(CAPABILITIES as readonly string[]).includes(item))) {
      domainError("FORBIDDEN", "可信平台能力映射无效");
    }
    return { member, role: access.role, capabilities: [...new Set(access.capabilities)] };
  }

  if (!member.role || !Array.isArray(member.capabilities) || member.capabilities.some((item) => !(CAPABILITIES as readonly string[]).includes(item))) {
    domainError("FORBIDDEN", "演示成员角色配置无效");
  }
  return { member, role: member.role, capabilities: [...new Set(member.capabilities)] };
}

export function requireCapability(context: AuthContext, capability: Capability, message = "当前账号未获得此操作权限"): void {
  if (!context.capabilities.includes(capability)) domainError("FORBIDDEN", message);
}

export function requireManagerOrAdmin(context: AuthContext, message = "需要主管或管理员权限"): void {
  if (context.role !== "manager" && context.role !== "admin") domainError("FORBIDDEN", message);
}

export function requireAdmin(context: AuthContext, message = "需要管理员权限"): void {
  if (context.role !== "admin") domainError("FORBIDDEN", message);
}

export function assertScopedRead(state: DomainState, context: AuthContext, scope: Scoped): void {
  if (scope.orgId !== state.orgId || context.member.orgId !== scope.orgId) domainError("NOT_FOUND", "记录不存在或当前账号无权访问");
  if (context.role !== "admin" && context.member.teamId !== scope.teamId) domainError("NOT_FOUND", "记录不存在或当前账号无权访问");
}

export function assertTeamTarget(state: DomainState, context: AuthContext, teamId: string): void {
  const team = state.teams.find((item) => item.id === teamId && item.orgId === state.orgId && item.active);
  if (!team) domainError("NOT_FOUND", "目标团队不存在");
  if (context.role !== "admin" && context.member.teamId !== teamId) domainError("FORBIDDEN", "不能跨团队操作");
}
