/** Invitation presets describe a pending grant; they are never an authorization source. */
export const INVITATION_ROLES = ['bd', 'shipping', 'links', 'brandManager'] as const;
export type InvitationRole = typeof INVITATION_ROLES[number];
export const INVITATION_ROLE_LABELS: Record<InvitationRole, string> = {
  bd: '商务', shipping: '供应链发货', links: '链接配置', brandManager: '品牌管理员',
};
export type InvitationState = 'pending' | 'claimed' | 'provisioning' | 'provision_failed' | 'completed' | 'revoked';
export type InvitationDisplayState = InvitationState | 'expired';
export interface InvitationBrandBinding { brandId: string; businessOwnerName: string | null }
export interface InvitationBrandSummary extends InvitationBrandBinding { brandName: string }
export interface InvitationClaimant {
  principalId: string;
  displayName: string;
  userType: 'internal' | 'external';
  claimedAt: string;
}
export interface MemberInvitation {
  id: string;
  recipientName: string;
  role: InvitationRole;
  brands: InvitationBrandSummary[];
  status: InvitationDisplayState;
  createdAt: string;
  expiresAt: string;
  claimant: InvitationClaimant | null;
  completedAt: string | null;
  revokedAt: string | null;
  /** A platform grant can precede an atomic brand binding; failed grants must stay visible. */
  roleGranted: boolean;
  issue: string | null;
  version: number;
  /** Calculated by the server from the raw lifecycle state, expiry and reservation lease. */
  actions: { approve: boolean; revoke: boolean; recover: boolean };
}
export interface CreateInvitationInput {
  recipientName: string;
  role: InvitationRole;
  brands: InvitationBrandBinding[];
  expiresInDays: 1 | 3 | 7;
}
export interface InvitationReadiness {
  canCreate: boolean;
  canApprove: boolean;
  message: string | null;
  localPreview: boolean;
}
export interface InvitationDirectory {
  invitations: MemberInvitation[];
  readiness: InvitationReadiness;
  availableRoles: InvitationRole[];
}
export interface CreatedInvitation {
  invitation: MemberInvitation;
  /** Only returned once. A fragment keeps the secret out of HTTP paths and referrers. */
  invitationPath: string;
}
export interface InvitationJoinContext {
  displayName: string;
  userType: 'internal' | 'external';
  localPreview: boolean;
  csrfToken?: string;
}
export interface InvitationJoinView {
  invitation: Pick<MemberInvitation, 'recipientName' | 'role' | 'brands' | 'status' | 'expiresAt' | 'completedAt'>;
  displayName: string;
  claimedByYou: boolean;
  canClaim: boolean;
  canEnter: boolean;
  message: string | null;
  localPreview: boolean;
}
