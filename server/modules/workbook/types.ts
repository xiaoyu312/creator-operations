import type { BrandWorkbookRole } from "../../../shared/brands.ts";

export type WorkbookRoleMapping = Record<BrandWorkbookRole, string[]> & {
  brandManager?: string[];
};
