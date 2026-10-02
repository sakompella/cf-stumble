import { MAX_EVIDENCE } from "./thresholds.mts";
import type { AppEvent, Invocation } from "./model.mts";

export function isoMinute(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16) + "Z";
}

export function eventId(event: AppEvent): string {
  return event.requestId ?? `${event.name}@${isoMinute(event.atMs)}`;
}

export function invocationId(invocation: Invocation): string {
  return `inv:${invocation.id}`;
}

export function firstIds(ids: readonly string[]): readonly string[] {
  return ids.slice(0, MAX_EVIDENCE);
}
