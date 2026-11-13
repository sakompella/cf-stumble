import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { Wake } from "@earendil-works/pi-durable";
import { isContinuedRun, type RunningConversation, type RunReport } from "./host-target.js";
import { logEvent, logRedactedCause } from "../../diagnostics.js";
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

const MODEL_TURN_KEY = "conversations.model-turn";

type ModelTurn = Readonly<{ instance: number; at: number }>;

type RunRow = Readonly<{
  conversation_id: string;
  run: number | null;
  deadline: number;
  ending: RunEnding | null;
  instance: number | null;
  continues: number;
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

function addContinuesColumn(sql: SqlStorage): void {
  const columns = sql
    .exec<{ readonly name: string }>("PRAGMA table_info(conversation_runs)")
    .toArray();

  if (!columns.some((column) => column.name === "continues")) {
    sql.exec("ALTER TABLE conversation_runs ADD COLUMN continues INTEGER NOT NULL DEFAULT 0");
  }
}

export class DeadlineAborts {
  readonly #ending = new Set<string>();

  waiting(expired: readonly string[]): readonly string[] {
    return expired.filter((conversationId) => !this.#ending.has(conversationId));
  }

  remainingMs(conversationId: string, running: number | undefined): number | undefined {
    return this.#ending.has(conversationId) ? PROJECT_RUN_DEADLINE_MS : running;
  }

  end(
    conversationId: string,
    abort: () => Promise<RunningConversation | null>,
    continued: (run: RunningConversation) => Promise<void>,
  ): void {
    this.#ending.add(conversationId);
    void abort()
      .then((run) => (isContinuedRun(run) ? continued(run) : undefined))
      .catch((cause: unknown) => {
        logRedactedCause("supervisor.conversations.facet-call", cause);
      })
      .finally(() => {
        this.#ending.delete(conversationId);
      });
  }
}

function stateFromRow(row: RunRow): ActiveRun {
  const fields = {
    run: row.run,
    deadline: row.deadline,
    instance: row.instance,
    continues: row.continues,
  };

  return row.ending === null
    ? RunState.cases.Running.make(fields)
    : RunState.cases.Ending.make({ ...fields, ending: row.ending });
}

export class ConversationRuns {
  readonly #storage: DurableObjectStorage;
  readonly #startedAt = Date.now();

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS conversation_runs (
        conversation_id TEXT PRIMARY KEY,
        run INTEGER,
        deadline INTEGER NOT NULL,
        ending TEXT CHECK (ending IN ('cancelled', 'interrupted')),
        instance INTEGER,
        continues INTEGER NOT NULL DEFAULT 0
      );
    `);
    addContinuesColumn(storage.sql);
  }

  cancelled(conversationId: string): string {
    return this.#ends(conversationId, "cancelled");
  }

  interrupted(conversationId: string): string {
    return this.#ends(conversationId, "interrupted");
  }

  modelTurn(instance: number, now: number): void {
    this.#storage.kv.put(MODEL_TURN_KEY, { instance, at: now } satisfies ModelTurn);
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
    report: RunReport,
    now: number,
    instance: number,
    generation: number | null,
  ): readonly Settlement[] {
    return this.#reported(report, (runs) => runs.keys(), now, instance, generation);
  }

  continued(
    run: RunningConversation,
    now: number,
    instance: number,
    generation: number | null,
  ): readonly Settlement[] {
    return this.#reported({ running: [run], failed: {} }, () => [], now, instance, generation);
  }

  #reported(
    { running, failed }: RunReport,
    tracked: (runs: ReadonlyMap<string, ActiveRun>) => Iterable<string>,
    now: number,
    instance: number,
    generation: number | null,
  ): readonly Settlement[] {
    const steps = this.#storage.transactionSync(() => {
      const runs = this.#runs();
      const modelTurn = this.#storage.kv.get<ModelTurn>(MODEL_TURN_KEY);

      const conversations = new Set([
        ...tracked(runs),
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
            modelTurnAt: modelTurn?.instance === instance ? modelTurn.at : null,
            supervisorStartedAt: this.#startedAt,
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
        `INSERT INTO conversation_runs (conversation_id, run, deadline, ending, instance, continues)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (conversation_id) DO UPDATE SET
           run = excluded.run, deadline = excluded.deadline, ending = excluded.ending,
           instance = excluded.instance, continues = excluded.continues`,
        conversationId,
        run.run,
        run.deadline,
        ending,
        run.instance,
        run.continues,
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
        "SELECT conversation_id, run, deadline, ending, instance, continues FROM conversation_runs",
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
    Settled: ({ outcome, errorCode, deadline, continues }) => {
      logEvent("info", "run.settled", {
        totalMs: now - (deadline - PROJECT_RUN_DEADLINE_MS),
        generation,
        outcome,
        errorCode,
        continues,
      });

      return [{ conversationId, outcome, errorCode }];
    },
  });
}
