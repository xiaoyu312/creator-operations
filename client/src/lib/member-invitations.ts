import type { InvitationDisplayState, MemberInvitation } from '../../../shared/invitations.ts';

export const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export function isInvitationToken(value: unknown): value is string {
  return typeof value === 'string' && INVITATION_TOKEN_PATTERN.test(value);
}

export interface InvitationTokenResolution {
  token: string | null;
  /** An invite parameter was present, even when malformed; it supersedes any older stored token. */
  hasIncomingInvite: boolean;
  shouldClearHash: boolean;
}

export function resolveInvitationToken(hash: string, storedToken: string | null): InvitationTokenResolution {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const hasIncomingInvite = params.has('invite');
  if (hasIncomingInvite) {
    const incoming = params.get('invite');
    return {
      token: isInvitationToken(incoming) ? incoming : null,
      hasIncomingInvite: true,
      shouldClearHash: true,
    };
  }
  return {
    token: isInvitationToken(storedToken) ? storedToken : null,
    hasIncomingInvite: false,
    shouldClearHash: false,
  };
}

export function invitationActions(actions: Partial<{ approve: boolean; revoke: boolean; recover: boolean }> | null | undefined) {
  return {
    canApprove: actions?.approve === true,
    canRevoke: actions?.revoke === true,
    canRecover: actions?.recover === true,
  };
}

export function approvalOutcome(invitation: Pick<MemberInvitation, 'status' | 'roleGranted'>) {
  if (invitation.status === 'completed') return 'completed' as const;
  if (invitation.status === 'provision_failed') return invitation.roleGranted ? 'partial' as const : 'failed' as const;
  if (invitation.status === 'provisioning') return 'processing' as const;
  return 'not-completed' as const;
}

export function invitationStatusLabel(status: InvitationDisplayState): string {
  const labels: Record<InvitationDisplayState, string> = {
    pending: '待领取',
    claimed: '待管理员确认',
    provisioning: '开通处理中',
    provision_failed: '开通未完成',
    completed: '已开通',
    revoked: '已撤销',
    expired: '已过期',
  };
  return labels[status];
}
