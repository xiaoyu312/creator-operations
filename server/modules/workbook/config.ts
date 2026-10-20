import { z } from 'zod';
import type { WorkbookModuleConfig } from './identity.ts';

export const workbookRoleMappingSchema = z.object({
  manager: z.array(z.string().trim().min(1).max(200)).max(50),
  bd: z.array(z.string().trim().min(1).max(200)).max(50),
  shipping: z.array(z.string().trim().min(1).max(200)).max(50),
  links: z.array(z.string().trim().min(1).max(200)).max(50),
  brandManager: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
}).strict();

export function loadWorkbookModuleConfig(environment: NodeJS.ProcessEnv = process.env): WorkbookModuleConfig {
  if (environment.DABO_ENABLE_PLATFORM !== "1") throw new Error("平台适配尚未显式启用。");
  if (environment.DABO_APP_MODE !== "workbook" && environment.DABO_APP_MODE !== "business") throw new Error("品牌模块只能由 DABO_APP_MODE=workbook 或 business 的入口初始化。");
  const expectedAppId = environment.DABO_EXPECTED_APP_ID ?? "";
  if (!/^app_[A-Za-z0-9]+$/u.test(expectedAppId)) throw new Error("请配置经核验的 DABO_EXPECTED_APP_ID。");
  const orgId = environment.DABO_ORG_ID?.trim() ?? "";
  if (!orgId) throw new Error("请配置固定的 DABO_ORG_ID。");
  const storeToken = environment.DABO_WORKBOOK_STORE_TOKEN ?? "";
  if (!/^[a-f0-9]{64}$/u.test(storeToken)) throw new Error("请配置有效的 DABO_WORKBOOK_STORE_TOKEN。");
  if (!environment.DABO_WORKBOOK_ROLE_MAPPING) throw new Error("请配置经核验的 DABO_WORKBOOK_ROLE_MAPPING。");
  let parsed: unknown;
  try {
    parsed = JSON.parse(environment.DABO_WORKBOOK_ROLE_MAPPING);
  } catch {
    throw new Error("DABO_WORKBOOK_ROLE_MAPPING 必须是有效 JSON。");
  }
  const roleMapping = workbookRoleMappingSchema.parse(parsed);
  if (roleMapping.manager.length === 0) throw new Error("DABO_WORKBOOK_ROLE_MAPPING.manager 至少需要一个平台角色 ID。");
  const managerIds = new Set(roleMapping.manager);
  if (roleMapping.brandManager.some((id) => managerIds.has(id))) {
    throw new Error("全局品牌管理员与限域品牌管理员角色映射不能重叠。");
  }
  const seenNonManagerIds = new Set<string>();
  for (const role of ["bd", "shipping", "links", "brandManager"] as const) {
    for (const id of roleMapping[role]) {
      if (seenNonManagerIds.has(id)) throw new Error("品牌管理员、商务、发货、链接角色映射不能重叠。");
      seenNonManagerIds.add(id);
    }
  }
  return { expectedAppId, orgId, storeToken, roleMapping };
}

