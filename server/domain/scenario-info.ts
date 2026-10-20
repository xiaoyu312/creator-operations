import type { AuditEvent, WorkspaceScenarioInfo } from "../../shared/types.ts";

const COUNT_FIELDS = [
  "sourceRowCount", "sourceCreatorCount", "sourceAccountCount",
  "simulatedAccountCount", "sourceProductCount",
] as const;

/** Project only the explicit provenance of this one authorized workspace. */
export function projectScenarioInfo(
  events: AuditEvent[],
  orgId: string,
  visibleTeamIds: string[],
): WorkspaceScenarioInfo | undefined {
  if (visibleTeamIds.length !== 1) return undefined;
  const markers = events.filter((event) => event.orgId === orgId
    && event.teamId === visibleTeamIds[0]
    && event.action === "source-scenario.seed.completed");
  if (markers.length !== 1) return undefined;
  const value = markers[0].after;
  if (!value || value.kind !== "source_scenario"
    || value.classification !== "real_or_mixed") return undefined;
  if (typeof value.sourceBrandId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value.sourceBrandId)
    || value.sourceBrandId === visibleTeamIds[0]) return undefined;
  if (typeof value.sourceFileName !== "string" || !value.sourceFileName.trim()
    || value.sourceFileName.length > 300
    || typeof value.sourceSha256 !== "string" || !/^[0-9a-f]{64}$/iu.test(value.sourceSha256)
    || typeof value.sourceReadAt !== "string" || !Number.isFinite(Date.parse(value.sourceReadAt))
    || typeof value.referenceDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value.referenceDate)) return undefined;
  if (COUNT_FIELDS.some((field) => typeof value[field] !== "number"
    || !Number.isSafeInteger(value[field]) || Number(value[field]) < 0)) return undefined;
  if (!Array.isArray(value.simulatedFields) || value.simulatedFields.length === 0
    || value.simulatedFields.length > 30
    || value.simulatedFields.some((field) => typeof field !== "string" || !field.trim() || field.length > 100)) return undefined;

  return {
    kind: "source_scenario",
    classification: "real_or_mixed",
    sourceBrandId: value.sourceBrandId,
    sourceFileName: value.sourceFileName,
    sourceSha256: value.sourceSha256,
    sourceReadAt: value.sourceReadAt,
    sourceRowCount: Number(value.sourceRowCount),
    referenceDate: value.referenceDate,
    sourceCreatorCount: Number(value.sourceCreatorCount),
    sourceAccountCount: Number(value.sourceAccountCount),
    simulatedAccountCount: Number(value.simulatedAccountCount),
    sourceProductCount: Number(value.sourceProductCount),
    simulatedFields: [...value.simulatedFields] as string[],
  };
}
