import type { Creator, OrderLine } from '../../../shared/types.ts';

export interface CreatorIdentityGroup {
  creatorIds: Set<string>;
  accountKeys: Set<string>;
  visibleCreatorIds: Set<string>;
}

export function creatorIdentityGroup(creatorId: string, visibleCreators: Creator[]): CreatorIdentityGroup {
  const byId = new Map(visibleCreators.map((creator) => [creator.id, creator]));
  const canonicalId = (startId: string) => {
    let currentId = startId;
    const visited = new Set<string>();
    while (!visited.has(currentId)) {
      visited.add(currentId);
      const nextId = byId.get(currentId)?.mergedIntoCreatorId;
      if (!nextId || !byId.has(nextId)) break;
      currentId = nextId;
    }
    return currentId;
  };
  const rootId = canonicalId(creatorId);
  const group = visibleCreators.filter((creator) => canonicalId(creator.id) === rootId);
  return {
    creatorIds: new Set(group.map((creator) => creator.id)),
    accountKeys: new Set(group.flatMap((creator) => creator.accounts.map((account) => `${account.platform}\u0000${account.externalAccountId}`))),
    visibleCreatorIds: new Set(visibleCreators.map((creator) => creator.id)),
  };
}

export function creatorOrderAttribution(creatorId: string, visibleCreators: Creator[], orders: OrderLine[]) {
  const group = creatorIdentityGroup(creatorId, visibleCreators);
  const attributed: OrderLine[] = [];
  let conflictingAccountLinks = 0;
  for (const order of orders) {
    if (order.creatorId && group.creatorIds.has(order.creatorId)) {
      attributed.push(order);
      continue;
    }
    const exactAccountMatch = Boolean(order.creatorAccountId && group.accountKeys.has(`${order.platform}\u0000${order.creatorAccountId}`));
    if (!exactAccountMatch) continue;
    if (order.creatorId && group.visibleCreatorIds.has(order.creatorId)) {
      conflictingAccountLinks += 1;
      continue;
    }
    attributed.push(order);
  }
  return { ...group, orders: attributed, conflictingAccountLinks };
}
