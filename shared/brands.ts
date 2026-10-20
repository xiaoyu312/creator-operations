/** Application-owned brand scopes; employee authorization also requires trusted platform roles. */
export const BRAND_WORKBOOK_ROLES = ['manager', 'bd', 'shipping', 'links'] as const;
export type BrandWorkbookRole = typeof BRAND_WORKBOOK_ROLES[number];

export interface WorkbookBrand {
  id: string;
  name: string;
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkbookBrandMember {
  id: string;
  brandId: string;
  principalId: string;
  displayName: string;
  /** Brand-specific source owner alias, required for BD and never inferred from displayName. */
  businessOwnerName: string | null;
  active: boolean;
  version: number;
}

export interface WorkbookBrandMemberInput {
  principalId: string;
  displayName: string;
  businessOwnerName: string | null;
  active: boolean;
  expectedVersion: number;
}

export interface WorkbookBrandCreateInput { name: string }
export interface WorkbookBrandUpdateInput { name?: string; active?: boolean; expectedVersion: number }
