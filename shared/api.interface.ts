import type { WorkbookBrand } from './brands.ts';

/** Fixed synthetic dataset creation, restricted to the application's global manager. */
export interface ExecutiveDemoResponse {
  brand: WorkbookBrand;
  created: boolean;
  referenceDate: string;
  counts: Record<string, number>;
}
export type { ScenarioReadOnlyWorkspace } from './scenario-readonly.ts';
export type {
  CreateInvitationInput, CreatedInvitation, InvitationDirectory,
  InvitationJoinContext, InvitationJoinView, MemberInvitation,
} from './invitations.ts';
