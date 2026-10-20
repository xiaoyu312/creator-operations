import type { AuditEntityType, AuditEvent, DomainState, Id, IsoDateTime, Scoped } from "../../shared/types.ts";
import { domainError } from "./errors.ts";

export interface DomainRuntime {
  now: () => IsoDateTime;
  id: (prefix: string) => Id;
}

export const defaultRuntime: DomainRuntime = {
  now: () => new Date().toISOString(),
  id: (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`,
};

export function assertIsoDateTime(value: string, field = "时间"): void {
  const validShape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
  if (!validShape || !Number.isFinite(Date.parse(value))) domainError("VALIDATION_ERROR", `${field}必须是带明确时区的 ISO 时间`);
}

export function assertSameOrg(state: DomainState, entity: Scoped): void {
  if (entity.orgId !== state.orgId) domainError("NOT_FOUND", "记录不存在或当前账号无权访问");
}

export function addAudit(
  state: DomainState,
  runtime: DomainRuntime,
  actorId: Id,
  scope: Scoped,
  entityType: AuditEntityType,
  entityId: Id,
  action: string,
  reason: string | null,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): AuditEvent {
  const event: AuditEvent = {
    id: runtime.id("audit"), actorId, orgId: scope.orgId, teamId: scope.teamId,
    entityType, entityId, action, occurredAt: runtime.now(), reason,
    before: redactAudit(before), after: redactAudit(after),
  };
  state.auditEvents.push(event);
  return event;
}

function redactAudit(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!value) return null;
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/phone|address|email|contact|recipient|internalnote|token|cookie|secret|credential/i.test(key)) continue;
    if (entry === null || ["string", "number", "boolean"].includes(typeof entry)) redacted[key] = entry;
    else if (Array.isArray(entry)) redacted[key] = `[${entry.length} items]`;
    else redacted[key] = "[object]";
  }
  return redacted;
}

export function incrementVersion<T extends { version: number; updatedAt: string; updatedBy: Id }>(entity: T, at: IsoDateTime, actorId: Id): T {
  entity.version += 1;
  entity.updatedAt = at;
  entity.updatedBy = actorId;
  return entity;
}

export function checkVersion(entity: { version: number }, expectedVersion: number): void {
  if (entity.version !== expectedVersion) {
    domainError("VERSION_CONFLICT", "记录已被其他人更新，请刷新后重试", { expectedVersion, actualVersion: entity.version });
  }
}

export function normalizeKey(value: string): string {
  return value.trim();
}

export function sameNullableString(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

export function stableStringify(value: unknown): string {
  if (value === undefined) return "\"[undefined]\"";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
}

/** Small deterministic content fingerprint; row-level keys and field comparisons remain authoritative. */
export function fingerprint(value: unknown): string {
  const input = stableStringify(value);
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  return seeds.map((seed) => {
    let hash = seed >>> 0;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
      hash ^= hash >>> 13;
    }
    return hash.toString(16).padStart(8, "0");
  }).join("");
}

export function assertValidCents(value: number | null, field: string): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) domainError("VALIDATION_ERROR", `${field}必须是非负安全整数分`);
}

export function addCents(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) domainError("BUSINESS_RULE_VIOLATION", "金额累计超出安全整数范围");
  return result;
}

export function assertUnique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) domainError("VALIDATION_ERROR", `${field}不能重复`);
}
