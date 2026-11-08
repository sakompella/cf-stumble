import * as Effect from "effect/Effect";
import type { Wake } from "@earendil-works/pi-durable";
import type { RunningConversation } from "../../facet/index.js";
import type { RunReport } from "./host-target.js";
import { logEvent } from "../../diagnostics.js";
import { PROJECT_RUN_DEADLINE_MS } from "../../turn-budget.js";
import type { RunOutcome } from "../probation.js";

const HEARTBEAT_MS = 60_000;

const WAKE_KEY = "conversations.wake";

type Run = Readonly<{ conversation_id: string; run: number | null; deadline: number }>;

function continues(run: Run, reported: RunningConversation): boolean {
  return (
    reported.conversationId === run.conversation_id &&
    (reported.run === undefined || reported.run === run.run)
  );
}

type RunEnding = Extract<RunOutcome, "cancelled" | "interrupted">;

export type FacetReplacement = Readonly<{
  command: Readonly<{ kind: "activate" | "rollback"; label: number }>;
  epoch: number;
}>;

export type Settlement = Readonly<{
  conversationId: string;
  outcome: RunOutcome;
  errorCode: string | null;
}>;

export class ConversationRuns {
  readonly #storage: DurableObjectStorage;

  readonly #endings = new Map<string, RunEnding>();

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS conversation_runs (
        conversation_id TEXT PRIMARY KEY,
        run INTEGER,
        deadline INTEGER NOT NULL
      );
    `);
  }

  cancelled(conversationId: string): string {
    return this.#ends(conversationId, "cancelled");
  }

  interrupted(conversationId: string): string {
    return this.#ends(conversationId, "interrupted");
  }

  #ends(conversationId: string, ending: RunEnding): string {
    if (this.#runs().some((run) => run.conversation_id === conversationId))
      this.#endings.set(conversationId, ending);

    return conversationId;
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

  reconcile(
    { running, failed }: RunReport,
    now: number,
    generation: number | null,
  ): readonly Settlement[] {
    const runs = this.#runs();
    const settled = runs.filter((run) => !running.some((reported) => continues(run, reported)));
    const started = running.filter((reported) => !runs.some((run) => continues(run, reported)));

    const settlements = settled.map((run): Settlement => {
      this.#storage.sql.exec(
        "DELETE FROM conversation_runs WHERE conversation_id = ?",
        run.conversation_id,
      );

      const errorCode = failed[run.conversation_id] ?? null;

      const outcome =
        this.#endings.get(run.conversation_id) ?? (errorCode === null ? "completed" : "failed");

      logEvent("info", "run.settled", {
        totalMs: now - (run.deadline - PROJECT_RUN_DEADLINE_MS),
        generation,
        outcome,
        errorCode,
      });
      this.#endings.delete(run.conversation_id);

      return { conversationId: run.conversation_id, outcome, errorCode };
    });

    for (const { conversationId, run } of started) {
      this.#storage.sql.exec(
        "INSERT INTO conversation_runs (conversation_id, run, deadline) VALUES (?, ?, ?)",
        conversationId,
        run ?? null,
        now + PROJECT_RUN_DEADLINE_MS,
      );
      logEvent("info", "run.started", { generation });
    }

    return settlements;
  }

  arm(wake: Wake, now: number): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.#storage.kv.put(WAKE_KEY, wake);

      return this.setAlarm(now);
    });
  }

  setAlarm(now: number): Effect.Effect<void> {
    return Effect.suspend(() => this.#writeAlarm(now));
  }

  #writeAlarm(now: number): Effect.Effect<void> {
    const wake = this.#storage.kv.get<Wake>(WAKE_KEY);

    const candidates = [
      wake?.active === true ? now + HEARTBEAT_MS : undefined,
      wake?.at,
      ...this.#runs()
        .map((run) => run.deadline)
        .filter((deadline) => deadline > now),
    ].filter((at) => at !== undefined);

    return Effect.promise(() =>
      candidates.length === 0
        ? this.#storage.deleteAlarm()
        : this.#storage.setAlarm(Math.min(...candidates)),
    );
  }

  #runs(): readonly Run[] {
    return this.#storage.sql
      .exec<Run>("SELECT conversation_id, run, deadline FROM conversation_runs")
      .toArray();
  }
}
