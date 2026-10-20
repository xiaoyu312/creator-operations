import type { InvitationBrandSummary, InvitationRole, InvitationState } from '../../shared/invitations.ts';

/** All fields are constructed from trusted server context, never from an HTTP body. */
export interface InvitationActor {
  principalId: string;
  displayName: string;
  userType: 'internal' | 'external';
  roleIds: string[];
  manager: boolean;
}
export interface StoredInvitation {
  id: string;
  recipientName: string;
  role: InvitationRole;
  roleId: string;
  brands: InvitationBrandSummary[];
  tokenHash: string;
  status: InvitationState;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  claimant: (InvitationActor & { claimedAt: string }) | null;
  approval: { attemptId: string; actorId: string; startedAt: string } | null;
  completedAt: string | null;
  revokedAt: string | null;
  roleGranted: boolean;
  issueCode: 'platform_grant_unverified' | 'brand_binding_failed' | null;
  version: number;
}
export type InvitationStoreOperation = 'list' | 'get' | 'create' | 'inspect' | 'claim' | 'revoke' | 'reserve' | 'complete' | 'fail';
/**
 * create/list/revoke/reserve/complete/fail require a global manager.
 * inspect/claim require a logged-in real principal and the opaque token digest.
 * reserve/complete must recheck active brands and reject ANY existing membership
 * outside the invitation or conflicting/inactive owner binding. complete atomically
 * inserts missing wb_member rows and consumes the reservation; existing rows are
 * not overwritten. Claim is single-person and idempotent for that same principal.
 */
export interface InvitationStore {
  call(actor: InvitationActor, operation: InvitationStoreOperation, params: Record<string, unknown>): Promise<StoredInvitation | StoredInvitation[]>;
}
export interface InvitationRoleDirectory {
  roleIds: string[];
  /** Cannot infer this from an empty/missing SDK response. */
  unsafeBroadRoles: boolean;
}
export interface InvitationRoleGateway {
  directory(actor: InvitationActor): Promise<InvitationRoleDirectory>;
  /** Adds only this exact platform role and independently reads the membership back. */
  grantAndVerify(roleId: string, principalId: string): Promise<void>;
}
