import type { Wake } from "@earendil-works/pi-durable";
import { logEvent } from "../../diagnostics.js";
import { PROJECT_RUN_DEADLINE_MS } from "../../turn-budget.js";

const HEARTBEAT_MS = 60_000;

const RUN_DEADLINE_KEY = "conversations.run-deadline";

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

export class RunDeadline {
  readonly #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  get(): number | undefined {
    return this.#storage.kv.get<number>(RUN_DEADLINE_KEY);
  }

  clear(): void {
    this.#storage.kv.delete(RUN_DEADLINE_KEY);
  }

  remainingMs(now: number): number {
    return Math.max(0, (this.get() ?? now + PROJECT_RUN_DEADLINE_MS) - now);
  }

  async arm(wake: Wake, settled: () => void): Promise<void> {
    const now = Date.now();
    let deadline = this.get();

    if (wake.active && deadline === undefined) {
      deadline = now + PROJECT_RUN_DEADLINE_MS;
      this.#storage.kv.put(RUN_DEADLINE_KEY, deadline);
      logEvent("info", "run.started");
    }

    if (!wake.active && deadline !== undefined) {
      logEvent("info", "run.settled", { totalMs: now - (deadline - PROJECT_RUN_DEADLINE_MS) });
      deadline = undefined;
      this.clear();
      settled();
    }

    const at = alarmAt(wake, now, deadline);

    await (at === undefined ? this.#storage.deleteAlarm() : this.#storage.setAlarm(at));
  }
}
