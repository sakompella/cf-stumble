import type { Wake } from "@earendil-works/pi-durable";

const HEARTBEAT_MS = 60_000;

export function alarmAt(
  wake: Wake,
  now: number,
  runDeadline: number | undefined,
): number | undefined {
  const candidates = [
    wake.active ? now + HEARTBEAT_MS : undefined,
    wake.at,
    wake.active ? runDeadline : undefined,
  ].filter((at) => at !== undefined);

  return candidates.length === 0 ? undefined : Math.min(...candidates);
}
