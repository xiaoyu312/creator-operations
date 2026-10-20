import type { IsoDateTime, TaskKind } from "../../shared/types.ts";

/** Temporary P0 calendar-hour targets; product configuration can replace these after business review. */
export const SYSTEM_TASK_SLA_HOURS: Readonly<Partial<Record<TaskKind, number>>> = Object.freeze({
  sample_approval: 24,
  sample_shipment: 48,
  sample_receipt: 24 * 7,
  cooperation_approval: 24,
  delivery_review: 24,
});

export function taskDueAt(base: IsoDateTime, kind: TaskKind): IsoDateTime | null {
  const hours = SYSTEM_TASK_SLA_HOURS[kind];
  if (hours === undefined) return null;
  const timestamp = Date.parse(base);
  if (!Number.isFinite(timestamp)) throw new Error("Task SLA base time must be a valid ISO timestamp");
  return new Date(timestamp + hours * 60 * 60 * 1000).toISOString();
}
