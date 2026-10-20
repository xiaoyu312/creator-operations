import { DomainError } from "../../domain/errors.ts";
import type { WorkbookBrand, WorkbookBrandMember } from "../../../shared/brands.ts";
import type { LocalWorkbookActor } from "../../../shared/workbook.ts";
import { EXECUTIVE_DEMO_PRINCIPALS } from "../../../shared/synthetic-principals.ts";
import { isUnavailableDemoBrand } from "../../../shared/scenario-brand.ts";
import type { WorkbookWorkspaceRegistry } from "../../workbook/storage.ts";
import type { WorkbookRoleMapping } from "./types.ts";

export interface WorkbookPlatformContext {
  userId?: string;
  appId?: string;
  roles?: string[];
  userName?: string;
  userNameI18n?: Record<string, string>;
  isSystemAccount?: boolean;
}

export interface WorkbookModuleConfig {
  expectedAppId: string;
  orgId: string;
  storeToken: string;
  roleMapping: WorkbookRoleMapping;
}

export interface WorkbookAccess {
  principalId: string;
  displayName: string;
  platformRole: "manager" | "bd" | "shipping" | "links";
  actor: LocalWorkbookActor;
  brand: WorkbookBrand | null;
  membership: WorkbookBrandMember | null;
  visibleBrands: WorkbookBrand[];
  canManageBrands: boolean;
}

const USER_ID_RE = /^\d{1,30}$/u;

export function resolveWorkbookPlatformRole(
  context: WorkbookPlatformContext | undefined,
  config: WorkbookModuleConfig,
): { principalId: string; displayName: string; role: WorkbookAccess["platformRole"]; canManageBrands: boolean } {
  if (!context?.userId || !USER_ID_RE.test(context.userId) || context.appId !== config.expectedAppId) {
    throw new DomainError("UNAUTHENTICATED", "妙搭登录身份或应用绑定未通过校验。");
  }
  if (EXECUTIVE_DEMO_PRINCIPALS.some((principalId) => principalId === context.userId)) {
    throw new DomainError("FORBIDDEN", "演示成员不能用于登录。");
  }
  if (context.isSystemAccount === true) {
    throw new DomainError("FORBIDDEN", "系统账号不能访问品牌工作簿。");
  }
  if (context.roles === undefined) {
    throw new DomainError("UNAUTHENTICATED", "当前请求缺少可信平台角色上下文。");
  }
  if (!Array.isArray(context.roles) || context.roles.length === 0 || context.roles.some((role) => typeof role !== "string" || role.length === 0)) {
    throw new DomainError("FORBIDDEN", "当前账号没有有效的平台工作簿岗位。");
  }

  const supplied = new Set(context.roles);
  const hasRole = (role: WorkbookAccess["platformRole"]): boolean => config.roleMapping[role].some((id) => supplied.has(id));
  let role: WorkbookAccess["platformRole"] | null = null;
  let canManageBrands = false;
  if (hasRole("manager")) {
    role = "manager";
    canManageBrands = true;
  } else {
    const matches: WorkbookAccess["platformRole"][] = [];
    if (config.roleMapping.brandManager?.some((id) => supplied.has(id))) matches.push("manager");
    matches.push(...(["bd", "shipping", "links"] as const).filter(hasRole));
    if (matches.length > 1) {
      throw new DomainError("FORBIDDEN", "当前账号命中多个工作簿岗位，请由管理员调整平台角色配置。");
    }
    role = matches[0] ?? null;
  }
  if (!role) throw new DomainError("FORBIDDEN", "当前账号未分配工作簿平台岗位。");

  const platformName = typeof context.userName === "string" ? context.userName.trim() : "";
  const localizedName = typeof context.userNameI18n?.zh_cn === "string" ? context.userNameI18n.zh_cn.trim() : "";
  const displayName = platformName || localizedName || roleLabel(role);
  return { principalId: context.userId, displayName, role, canManageBrands };
}

export class WorkbookIdentityService {
  constructor(
    private readonly registry: WorkbookWorkspaceRegistry,
    private readonly config: WorkbookModuleConfig,
  ) {}

  async authorize(context: WorkbookPlatformContext | undefined, requestedBrandId?: string): Promise<WorkbookAccess> {
    const principal = resolveWorkbookPlatformRole(context, this.config);
    const allBrands = await this.registry.listBrands();
    const activeBrands = allBrands.filter((brand) => brand.active);
    const canManageBrands = principal.canManageBrands;
    const memberships = canManageBrands ? [] : await this.registry.membershipsFor(principal.principalId);
    const accessibleBrands = canManageBrands
      ? sortBrands(activeBrands)
      : sortBrands(activeBrands.filter((brand) => this.activeMembershipForBrand(memberships, brand.id, principal.role) !== null));
    const visibleBrands = accessibleBrands.filter((brand) => !isUnavailableDemoBrand(brand));

    if (!canManageBrands && visibleBrands.length === 0) {
      throw new DomainError("FORBIDDEN", "当前账号尚未加入可访问的品牌工作簿。");
    }
    let brand: WorkbookBrand | null = null;
    if (requestedBrandId !== undefined) {
      const requested = allBrands.find((item) => item.id === requestedBrandId) ?? null;
      if (requested && isUnavailableDemoBrand(requested)) {
        brand = visibleBrands[0] ?? null;
      } else {
        const accessible = accessibleBrands.find((item) => item.id === requestedBrandId) ?? null;
        if (!accessible) throw new DomainError("FORBIDDEN", "当前账号无权访问此品牌工作簿。");
        brand = accessible;
      }
    } else {
      brand = visibleBrands[0] ?? null;
    }
    if (!brand && !canManageBrands) throw new DomainError("FORBIDDEN", "当前账号尚未加入可访问的品牌工作簿。");

    const membership = brand && !canManageBrands
      ? this.activeMembershipForBrand(memberships, brand.id, principal.role)
      : null;
    const actor = makeWorkbookActor(principal.principalId, principal.displayName, principal.role, membership);
    return {
      principalId: principal.principalId,
      displayName: principal.displayName,
      platformRole: principal.role,
      actor,
      brand,
      membership,
      visibleBrands,
      canManageBrands,
    };
  }

  async requireManager(context: WorkbookPlatformContext | undefined): Promise<{ principalId: string; displayName: string }> {
    const principal = resolveWorkbookPlatformRole(context, this.config);
    if (!principal.canManageBrands) throw new DomainError("FORBIDDEN", "品牌配置仅限平台品牌管理员操作。");
    return { principalId: principal.principalId, displayName: principal.displayName };
  }

  async brandDirectory(context: WorkbookPlatformContext | undefined): Promise<{ brands: WorkbookBrand[]; canManageBrands: boolean }> {
    const principal = resolveWorkbookPlatformRole(context, this.config);
    if (principal.canManageBrands) {
      const brands = (await this.registry.listBrands()).filter((brand) => !isUnavailableDemoBrand(brand));
      return { brands: sortBrands(brands), canManageBrands: true };
    }
    const access = await this.authorize(context);
    return { brands: access.visibleBrands, canManageBrands: false };
  }

  async requireManagedBrand(context: WorkbookPlatformContext | undefined, brandId: string): Promise<{ principalId: string; displayName: string; brand: WorkbookBrand }> {
    const manager = await this.requireManager(context);
    const brand = await this.registry.getBrand(brandId);
    if (!brand) throw new DomainError("NOT_FOUND", "品牌不存在。");
    return { ...manager, brand };
  }

  private activeMembershipForBrand(
    memberships: WorkbookBrandMember[],
    brandId: string,
    role: WorkbookAccess["platformRole"],
  ): WorkbookBrandMember | null {
    const matches = memberships.filter((member) => member.brandId === brandId && member.active);
    if (matches.length > 1) throw new DomainError("FORBIDDEN", "品牌成员绑定存在重复记录，请联系管理员核对。");
    const member = matches[0];
    if (!member) return null;
    if (role === "bd" && (!member.businessOwnerName || !member.businessOwnerName.trim())) return null;
    return member;
  }
}

function makeWorkbookActor(
  principalId: string,
  displayName: string,
  role: WorkbookAccess["platformRole"],
  membership: WorkbookBrandMember | null,
): LocalWorkbookActor {
  switch (role) {
    case "manager":
      return { memberId: principalId, displayName, role: "local_manager" };
    case "bd":
      if (!membership?.businessOwnerName?.trim()) throw new DomainError("FORBIDDEN", "商务账号缺少此品牌的商务姓名绑定。");
      return { memberId: principalId, displayName, role: "local_bd", businessOwnerName: membership.businessOwnerName.trim() };
    case "shipping":
      return { memberId: principalId, displayName, role: "local_shipping" };
    case "links":
      return { memberId: principalId, displayName, role: "local_links" };
  }
}

function roleLabel(role: WorkbookAccess["platformRole"]): string {
  if (role === "manager") return "品牌管理员";
  if (role === "bd") return "商务";
  if (role === "shipping") return "发货";
  return "链接";
}

function sortBrands(brands: WorkbookBrand[]): WorkbookBrand[] {
  return [...brands].sort((left, right) => left.name.localeCompare(right.name, "zh-CN") || left.id.localeCompare(right.id));
}
