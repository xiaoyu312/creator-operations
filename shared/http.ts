import type { ImportPreviewResult, SessionSnapshot } from './types.ts';
import type { LocalWorkbookActor } from './workbook.ts';
import type { WorkbookBrand } from './brands.ts';

export interface WorkbookWorkspaceSession {
  label: string;
  sourceFileName: string;
  sourceSha256: string;
  readAt: string;
  role: LocalWorkbookActor['role'];
  businessOwnerName: string | null;
  availableBusinessOwners: string[];
  rolePreview: boolean;
  storage: 'local' | 'cloud';
  brandId?: string | null;
  brandName?: string;
}

export type CsvKind = 'creators' | 'orders' | 'refunds';
export type ExportKind = 'creators' | 'samples' | 'cooperations' | 'schedules' | 'deliveries' | 'orders' | 'refunds' | 'tasks';

export interface CsvImportRequest {
  kind: CsvKind;
  csvText: string;
  sourceName?: string;
  /** canonical field -> uploaded CSV column */
  columnMapping?: Record<string, string>;
}

export interface CsvImportCommitRequest extends CsvImportRequest {
  previewHash: string;
}

export interface CsvPreviewResponse {
  previewHash: string;
  kind: CsvKind;
  sourceName: string;
  totalRows: number;
  headers: string[];
  rows: Array<{ rowNumber: number; values: Record<string, string> }>;
  result: ImportPreviewResult | null;
  validationErrors: Array<{ rowNumber: number; field?: string; message: string }>;
}

export interface SessionResponse extends SessionSnapshot {
  /** A connected brand business workspace, distinct from source-sheet browsing. */
  businessWorkspace?: {
    brandId: string;
    brandName: string;
    storage: 'local' | 'cloud';
    role: 'manager' | 'bd' | 'shipping' | 'links';
    rolePreview: boolean;
  };
  /** Local isolated demo only. Production uses the platform's CSRF transport. */
  demoCsrfToken?: string;
  /** Loopback-only source workbook session. Never provided by the production root. */
  localCsrfToken?: string;
  localWorkbook?: {
    label: string; sourceFileName: string; sourceSha256: string; readAt: string;
    role: LocalWorkbookActor['role'];
    businessOwnerName: string | null;
    availableBusinessOwners: string[];
    /** The local machine owner can preview roles. This is not a real employee login. */
    rolePreview: true;
  };
  /** Present for the production, brand-scoped workbook workspace. Never supplies a local preview identity. */
  workbook?: WorkbookWorkspaceSession;
  brands?: WorkbookBrand[];
  canManageBrands?: boolean;
  canCreateDemo?: boolean;
  appName: string;
}

export interface LocalRoleSelection { role: LocalWorkbookActor['role']; businessOwnerName?: string | null }

export interface ApiErrorResponse {
  error: { code: string; message: string; details?: unknown };
}
