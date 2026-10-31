import type { Wake } from "@earendil-works/pi-durable";
import { logEvent } from "../../diagnostics.js";
import { PROJECT_RUN_DEADLINE_MS } from "../../turn-budget.js";

const HEARTBEAT_MS = 60_000;

const WAKE_KEY = "conversations.wake";

type Run = Readonly<{ conversation_id: string; deadline: number }>;

export class ConversationRuns {
  readonly #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS conversation_runs (
        conversation_id TEXT PRIMARY KEY,
        deadline INTEGER NOT NULL
      );
    `);
  }

  running(now: number): boolean {
    return this.#runs().some((run) => run.deadline > now);
  }

  remainingMs(conversationId: string, now: number): number | undefined {
    const run = this.#runs().find((candidate) => candidate.conversation_id === conversationId);

    return run !== undefined && run.deadline > now ? run.deadline - now : undefined;
  }

  expired(now: number): readonly string[] {
    return this.#runs()
      .filter((run) => run.deadline <= now)
      .map((run) => run.conversation_id);
  }

  reconcile(running: readonly string[], now: number): readonly string[] {
    const runs = this.#runs();
    const recorded = new Set(runs.map((run) => run.conversation_id));
    const settled = runs.filter((run) => !running.includes(run.conversation_id));

    for (const conversationId of running.filter((id) => !recorded.has(id))) {
      this.#storage.sql.exec(
        "INSERT INTO conversation_runs (conversation_id, deadline) VALUES (?, ?)",
        conversationId,
        now + PROJECT_RUN_DEADLINE_MS,
      );
      logEvent("info", "run.started");
    }

    for (const run of settled) {
      this.#storage.sql.exec(
        "DELETE FROM conversation_runs WHERE conversation_id = ?",
        run.conversation_id,
      );
      logEvent("info", "run.settled", { totalMs: now - (run.deadline - PROJECT_RUN_DEADLINE_MS) });
    }

    return settled.map((run) => run.conversation_id);
  }

  async arm(wake: Wake, now: number): Promise<void> {
    this.#storage.kv.put(WAKE_KEY, wake);
    await this.setAlarm(now);
  }

  async setAlarm(now: number): Promise<void> {
    const wake = this.#storage.kv.get<Wake>(WAKE_KEY);

    const candidates = [
      wake?.active === true ? now + HEARTBEAT_MS : undefined,
      wake?.at,
      ...this.#runs()
        .map((run) => run.deadline)
        .filter((deadline) => deadline > now),
    ].filter((at) => at !== undefined);

    await (candidates.length === 0
      ? this.#storage.deleteAlarm()
      : this.#storage.setAlarm(Math.min(...candidates)));
  }

  #runs(): readonly Run[] {
    return this.#storage.sql
      .exec<Run>("SELECT conversation_id, deadline FROM conversation_runs")
      .toArray();
  }
}
