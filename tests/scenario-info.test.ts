import assert from "node:assert/strict";
import test from "node:test";
import type { AuditEvent } from "../shared/types.ts";
import { projectScenarioInfo } from "../server/domain/scenario-info.ts";

const teamId = "22222222-2222-4222-8222-222222222222";
function marker(): AuditEvent {
  return {
    id: "scenario-marker", orgId: "org", teamId,
    actorId: "actual-seed-operator", entityType: "import", entityId: "scenario",
    action: "source-scenario.seed.completed", occurredAt: "2026-10-15T00:00:00Z",
    reason: "scenario initialized", before: null,
    after: {
      kind: "source_scenario", classification: "real_or_mixed",
      sourceBrandId: "11111111-1111-4111-8111-111111111111",
      sourceFileName: "synthetic-source.xlsx", sourceSha256: "a".repeat(64),
      sourceReadAt: "2026-10-13T00:00:00Z", sourceRowCount: 20,
      referenceDate: "2026-10-15", sourceCreatorCount: 3, sourceAccountCount: 2,
      simulatedAccountCount: 10, sourceProductCount: 2,
      simulatedFields: ["订单", "成交金额"], extraPrivateField: "never projected",
    },
  };
}

test("scenario notice projects an explicit mixed-source marker without private extras", () => {
  const event = marker();
  const info = projectScenarioInfo([event], "org", [teamId]);
  assert.equal(info?.classification, "real_or_mixed");
  assert.equal(info?.sourceCreatorCount, 3);
  assert.equal("extraPrivateField" in (info ?? {}), false);
  info?.simulatedFields.push("changed locally");
  assert.deepEqual(event.after?.simulatedFields, ["订单", "成交金额"]);
});

test("scenario notice stays scoped to a single authorized team and organization", () => {
  const event = marker();
  assert.equal(projectScenarioInfo([event], "other-org", [teamId]), undefined);
  assert.equal(projectScenarioInfo([event], "org", ["another-team"]), undefined);
  assert.equal(projectScenarioInfo([event], "org", [teamId, "another-team"]), undefined);
  assert.equal(projectScenarioInfo([event, event], "org", [teamId]), undefined);
});

test("scenario notice rejects malformed provenance rather than displaying false source claims", () => {
  for (const change of [
    { classification: "synthetic_demo" }, { sourceBrandId: teamId },
    { sourceAccountCount: -1 }, { sourceSha256: "unknown" },
    { simulatedFields: [42] },
  ]) {
    const event = marker();
    event.after = { ...event.after, ...change };
    assert.equal(projectScenarioInfo([event], "org", [teamId]), undefined);
  }
});
