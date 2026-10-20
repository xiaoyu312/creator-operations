import assert from "node:assert/strict";
import { createDemoState } from "../shared/seed.ts";
import { DomainService, type DomainStore } from "../server/domain/domain-service.ts";
import type { DomainState } from "../shared/types.ts";

// Original fixed synthetic seed; no input files, services, storage or network.
let state: DomainState = createDemoState();
let sequence = 0;
const store: DomainStore = {
  read: async () => structuredClone(state),
  transaction: async <T>(operation: (draft: DomainState) => T | Promise<T>): Promise<T> => {
    const draft = structuredClone(state);
    const result = await operation(draft);
    state = draft;
    return structuredClone(result);
  },
};
const service = new DomainService(store, {
  runtime: { now: () => "2026-10-13T09:00:00+08:00", id: prefix => `synthetic-${prefix}-${++sequence}` },
});
const actor = { principalId: "demo:manager" };
const before = await service.getWorkspace(actor);
await service.execute(actor, {
  type: "creator.create",
  name: "虚构达人·演示新增",
  platform: "douyin",
  externalAccountId: "DEMO-EXTRA-001",
  displayName: "演示新增",
  source: "deterministic synthetic example",
});
const after = await service.getWorkspace(actor);
assert.equal(after.dataMode, "demo");
assert.equal(after.creators.length, before.creators.length + 1);
console.log(JSON.stringify({
  mode: "synthetic-only",
  creatorCountBefore: before.creators.length,
  creatorCountAfter: after.creators.length,
  persistence: "none",
  network: "none",
}, null, 2));
