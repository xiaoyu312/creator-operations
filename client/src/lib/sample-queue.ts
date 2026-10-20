import type { Role, SamplePackage, SampleRequest, WorkspaceSnapshot } from '../../../shared/types.ts';
import type { Creator, CreatorAccount, Platform } from '../../../shared/types.ts';
import { compareTimestamps } from './time.ts';

export type SampleQueueActor = Pick<WorkspaceSnapshot['actor'], 'memberId' | 'role' | 'capabilities'>;
export type SampleCreatorEligibilityActor = Pick<WorkspaceSnapshot['actor'], 'memberId' | 'role'>;

/** Returns the non-archived creator set permitted for a new sample application. */
export function selectEligibleSampleCreators({ creators, actor }: { creators: readonly Creator[]; actor: SampleCreatorEligibilityActor }): Creator[] {
  if (actor.role === 'ops') return [];
  const manager = actor.role === 'manager' || actor.role === 'admin';
  return creators.filter((creator) => !creator.archived && (manager || creator.ownerMemberId === actor.memberId));
}

export function selectSampleCreatorAccounts({ creators, actor, platform }: {
  creators: readonly Creator[];
  actor: SampleCreatorEligibilityActor;
  platform: Platform | 'all';
}): Array<{ creator: Creator; account: CreatorAccount }> {
  return selectEligibleSampleCreators({ creators, actor }).flatMap((creator) => creator.accounts
    .filter((account) => account.active && (platform === 'all' || account.platform === platform))
    .map((account) => ({ creator, account })));
}

/** Legacy requests without a recorded platform remain visible in the all-platform view. */
export function sampleMatchesPlatform(sample: Pick<SampleRequest, 'platform'>, platform: Platform | 'all'): boolean {
  return platform === 'all' || sample.platform === platform;
}

export interface SelectActionableSamplesInput {
  samples: readonly SampleRequest[];
  creators: readonly Creator[];
  samplePackages: readonly SamplePackage[];
  actor: SampleQueueActor;
}

/** Returns the current actor's actionable sample requests, ordered like the business home queue. */
export function selectActionableSamples({ samples, creators, samplePackages, actor }: SelectActionableSamplesInput): SampleRequest[] {
  const creatorsById = new Map(creators.map((creator) => [creator.id, creator]));
  const openReceiptSampleIds = new Set(samplePackages.filter((samplePackage) => !samplePackage.receivedAt).map((samplePackage) => samplePackage.sampleId));

  return samples.filter((sample) => {
    const creator = creatorsById.get(sample.creatorId);
    if (actor.role === 'bd' && sample.applicantId !== actor.memberId && creator?.ownerMemberId !== actor.memberId) return false;
    if (sample.status === 'pending_approval') return actor.capabilities.includes('sample.approve') && sample.applicantId !== actor.memberId;
    if (sample.status === 'pending_shipment') return actor.capabilities.includes('sample.fulfill');
    return sample.status === 'shipped' && actor.capabilities.includes('sample.fulfill') && openReceiptSampleIds.has(sample.id);
  }).sort((left, right) => sampleQueuePriority(left) - sampleQueuePriority(right) || compareTimestamps(left.createdAt, right.createdAt));
}

function sampleQueuePriority(sample: SampleRequest) {
  return sample.status === 'pending_approval' ? 0 : sample.status === 'pending_shipment' ? 1 : 2;
}

export interface SampleRosterActor {
  memberId: string;
  role: Role;
}

/** Samples this person can see. Does not decide who may approve, ship, or confirm receipt. */
export function selectVisibleSamples({ samples, creators, actor, teamIds }: {
  samples: readonly SampleRequest[];
  creators: readonly Creator[];
  actor: SampleRosterActor;
  teamIds: readonly string[];
}): SampleRequest[] {
  const creatorsById = new Map(creators.map((creator) => [creator.id, creator]));
  return samples.filter((sample) => {
    if (!teamIds.includes(sample.teamId)) return false;
    if (actor.role !== 'bd') return true;
    const creator = creatorsById.get(sample.creatorId);
    return sample.applicantId === actor.memberId || creator?.ownerMemberId === actor.memberId;
  });
}

/** Pending applications in the visible set, including the viewer's own submissions. */
export function selectPendingApprovalRoster(input: {
  samples: readonly SampleRequest[];
  creators: readonly Creator[];
  actor: SampleRosterActor;
  teamIds: readonly string[];
}): SampleRequest[] {
  return selectVisibleSamples(input)
    .filter((sample) => sample.status === 'pending_approval')
    .sort((left, right) => compareTimestamps(left.createdAt, right.createdAt));
}

/**
 * One shipped application per row, and only when a package is still unreceived.
 * Several open packages do not turn one application into several rows.
 * A shipped application whose packages are all received is not waiting.
 */
export function selectAwaitingReceiptSamples(input: {
  samples: readonly SampleRequest[];
  creators: readonly Creator[];
  samplePackages: readonly SamplePackage[];
  actor: SampleRosterActor;
  teamIds: readonly string[];
}): SampleRequest[] {
  const openSampleIds = new Set(input.samplePackages.filter((item) => !item.receivedAt).map((item) => item.sampleId));
  return selectVisibleSamples(input)
    .filter((sample) => sample.status === 'shipped' && openSampleIds.has(sample.id))
    .sort((left, right) => compareTimestamps(left.createdAt, right.createdAt));
}

/** People who cannot approve are not sent into the reviewer-only queue. */
export function homeApprovalListPath(canApprove: boolean) {
  return canApprove ? '/samples?queue=approval' : '/samples?status=pending_approval';
}
