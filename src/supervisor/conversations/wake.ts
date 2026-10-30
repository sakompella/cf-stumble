import type { Wake } from "@earendil-works/pi-durable";

/** Pi Durable's recovery heartbeat: a lost instance is woken again within this while work runs. */
const HEARTBEAT_MS = 60_000;

/**
 * When the Supervisor's alarm must next fire: soon while a run is active, at the earliest sleep,
 * and no later than the run's deadline. `undefined` means nothing needs a process.
 */
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
