import type { WorkbookLocalState, WorkbookSourceManifest } from '../../shared/workbook.ts';
import type { WorkbookBrand, WorkbookBrandMember, WorkbookBrandMemberInput, WorkbookBrandUpdateInput } from '../../shared/brands.ts';

/** All mutations execute against the latest persisted state under a workspace lock. */
export interface WorkbookStateStore {
  read(): Promise<WorkbookLocalState>;
  transaction<T>(operation: (draft: WorkbookLocalState) => T | Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

export interface WorkbookWorkspaceRegistry {
  listBrands(): Promise<WorkbookBrand[]>;
  getBrand(brandId: string): Promise<WorkbookBrand | null>;
  createBrand(name: string, actorId: string): Promise<WorkbookBrand>;
  updateBrand(brandId: string, input: WorkbookBrandUpdateInput, actorId: string): Promise<WorkbookBrand>;
  listMembers(brandId: string): Promise<WorkbookBrandMember[]>;
  membershipsFor(principalId: string): Promise<WorkbookBrandMember[]>;
  upsertMember(brandId: string, input: WorkbookBrandMemberInput, actorId: string): Promise<WorkbookBrandMember>;
  /** Does not create, initialize or import data merely by resolving the store. */
  forBrand(brandId: string): WorkbookStateStore;
}

/** Used only by explicitly authorized source import. Local service continues to hash the actual source file. */
export type WorkbookSourceVerifier = (manifest: WorkbookSourceManifest) => Promise<void>;
