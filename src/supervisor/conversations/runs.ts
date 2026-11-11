import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { Wake } from "@earendil-works/pi-durable";
import type { RunReport } from "./host-target.js";
import { logEvent } from "../../diagnostics.js";
import { PROJECT_RUN_DEADLINE_MS } from "../../turn-budget.js";
import {
  RunCommand,
  RunEvent,
  RunState,
  transition,
  type ActiveRun,
  type RunEnding,
  type RunOutcome,
} from "./run-machine.js";

const HEARTBEAT_MS = 60_000;

const WAKE_KEY = "conversations.wake";

type RunRow = Readonly<{
  conversation_id: string;
  run: number | null;
  deadline: number;
  ending: RunEnding | null;
  instance: number | null;
}>;

export type FacetReplacement = Readonly<{
  command: Readonly<{ kind: "activate" | "rollback"; label: number }>;
  epoch: number;
}>;

export class AlarmWriteFailed extends Data.TaggedError("AlarmWriteFailed")<{
  readonly cause: unknown;
}> {}

export type Settlement = Readonly<{
  conversationId: string;
  outcome: RunOutcome;
  errorCode: string | null;
}>;

function stateFromRow(row: RunRow): ActiveRun {
  const fields = { run: row.run, deadline: row.deadline, instance: row.instance };

  return row.ending === null
    ? RunState.cases.Running.make(fields)
    : RunState.cases.Ending.make({ ...fields, ending: row.ending });
}

export class ConversationRuns {
  readonly #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS conversation_runs (
        conversation_id TEXT PRIMARY KEY,
        run INTEGER,
        deadline INTEGER NOT NULL,
        ending TEXT CHECK (ending IN ('cancelled', 'interrupted')),
        instance INTEGER
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
    this.#storage.transactionSync(() => {
      const state = this.#runs().get(conversationId) ?? RunState.cases.Idle.make({});

      this.#write(conversationId, transition(state, RunEvent.Ended({ ending })).state);
    });

    return conversationId;
  }

  running(now: number): boolean {
    return [...this.#runs().values()].some((run) => run.deadline > now);
  }

  remainingMs(conversationId: string, now: number): number | undefined {
    const run = this.#runs().get(conversationId);

    return run !== undefined && run.deadline > now ? run.deadline - now : undefined;
  }

  expired(now: number): readonly string[] {
    return [...this.#runs()].flatMap(([conversationId, run]) =>
      run.deadline <= now ? [conversationId] : [],
    );
  }

  reconcile(
    { running, failed }: RunReport,
    now: number,
    instance: number,
    generation: number | null,
  ): readonly Settlement[] {
    const steps = this.#storage.transactionSync(() => {
      const runs = this.#runs();

      const conversations = new Set([
        ...runs.keys(),
        ...running.map((reported) => reported.conversationId),
      ]);

      return [...conversations].map((conversationId) => {
        const step = transition(
          runs.get(conversationId) ?? RunState.cases.Idle.make({}),
          RunEvent.Reported({
            report: running.find((reported) => reported.conversationId === conversationId),
            errorCode: failed[conversationId] ?? null,
            instance,
            now,
          }),
        );

        this.#write(conversationId, step.state);

        return { conversationId, commands: step.commands };
      });
    });

    return steps.flatMap(({ conversationId, commands }) =>
      commands.flatMap((command) => perform(command, conversationId, now, generation)),
    );
  }

  arm(wake: Wake, now: number): Effect.Effect<void, AlarmWriteFailed> {
    return Effect.suspend(() => {
      this.#storage.kv.put(WAKE_KEY, wake);

      return this.setAlarm(now);
    });
  }

  setAlarm(now: number): Effect.Effect<void, AlarmWriteFailed> {
    return Effect.suspend(() => this.#writeAlarm(now));
  }

  #writeAlarm(now: number): Effect.Effect<void, AlarmWriteFailed> {
    const wake = this.#storage.kv.get<Wake>(WAKE_KEY);

    const candidates = [
      wake?.active === true ? now + HEARTBEAT_MS : undefined,
      wake?.at,
      ...[...this.#runs().values()].flatMap((run) => (run.deadline > now ? [run.deadline] : [])),
    ].filter((at) => at !== undefined);

    return Effect.tryPromise({
      try: () =>
        candidates.length === 0
          ? this.#storage.deleteAlarm()
          : this.#storage.setAlarm(Math.min(...candidates)),
      catch: (cause) => new AlarmWriteFailed({ cause }),
    });
  }

  #write(conversationId: string, state: RunState): void {
    const { sql } = this.#storage;

    const upsert = (run: ActiveRun, ending: RunEnding | null) =>
      sql.exec(
        `INSERT INTO conversation_runs (conversation_id, run, deadline, ending, instance)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (conversation_id) DO UPDATE SET
           run = excluded.run, deadline = excluded.deadline,
           ending = excluded.ending, instance = excluded.instance`,
        conversationId,
        run.run,
        run.deadline,
        ending,
        run.instance,
      );

    RunState.match(state, {
      Idle: () =>
        sql.exec("DELETE FROM conversation_runs WHERE conversation_id = ?", conversationId),
      Running: (run) => upsert(run, null),
      Ending: (run) => upsert(run, run.ending),
    });
  }

  #runs(): ReadonlyMap<string, ActiveRun> {
    const rows = this.#storage.sql
      .exec<RunRow>(
        "SELECT conversation_id, run, deadline, ending, instance FROM conversation_runs",
      )
      .toArray();

    return new Map(rows.map((row) => [row.conversation_id, stateFromRow(row)] as const));
  }
}

function perform(
  command: RunCommand,
  conversationId: string,
  now: number,
  generation: number | null,
): readonly Settlement[] {
  return RunCommand.$match(command, {
    Started: () => {
      logEvent("info", "run.started", { generation });

      return [];
    },
    Settled: ({ outcome, errorCode, deadline }) => {
      logEvent("info", "run.settled", {
        totalMs: now - (deadline - PROJECT_RUN_DEADLINE_MS),
        generation,
        outcome,
        errorCode,
      });

      return [{ conversationId, outcome, errorCode }];
    },
  });
}
