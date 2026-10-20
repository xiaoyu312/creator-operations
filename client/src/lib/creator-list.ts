import type { Platform } from '../../../shared/types.ts';

export interface CreatorListScopeRecord {
  archived: boolean;
  mergedIntoCreatorId: string | null;
  teamId: string;
  ownerMemberId: string | null;
}

export interface CreatorListScope {
  view: 'public' | 'team' | 'mine';
  allowedTeamIds: readonly string[];
  teamId: string;
  ownerMemberId: string;
  memberId: string;
}

export type CreatorCreatedDestination = {
  path: '/public-pool' | '/creators';
  values: Record<string, string>;
};

export function creatorsInVisibleScope<T extends CreatorListScopeRecord>(creators: readonly T[], scope: CreatorListScope): T[] {
  return creators.filter((creator) => {
    if (creator.archived || creator.mergedIntoCreatorId) return false;
    if (scope.view === 'public') {
      if (creator.ownerMemberId !== null || !scope.allowedTeamIds.includes(creator.teamId)) return false;
      if (scope.teamId !== 'all' && creator.teamId !== scope.teamId) return false;
    } else if (scope.view === 'team') {
      if (!scope.allowedTeamIds.includes(creator.teamId)) return false;
      if (scope.teamId !== 'all' && creator.teamId !== scope.teamId) return false;
      if (creator.ownerMemberId === null) return false;
      if (scope.ownerMemberId !== 'all' && creator.ownerMemberId !== scope.ownerMemberId) return false;
    } else if (creator.ownerMemberId !== scope.memberId) return false;
    return true;
  });
}

export function isImplicitDefaultCreatorPlatform(platform: string, hasExplicitPlatform: boolean, hasVisibleCreatorCandidates: boolean): boolean {
  return !hasExplicitPlatform && platform === 'douyin' && !hasVisibleCreatorCandidates;
}

export function creatorCreatedDestination(makePublic: boolean, platform: Platform): CreatorCreatedDestination {
  return makePublic
    ? { path: '/public-pool', values: { platform } }
    : { path: '/creators', values: { scope: 'mine', platform } };
}
