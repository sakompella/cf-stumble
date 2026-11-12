import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  type HarnessSettings,
  type SubmissionId,
  type TaskGraph,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import {
  errorFields,
  hostLog,
  type ConversationHost,
  type GenerationControl,
  type ModelCapability,
  type RunFailures,
} from "../conversation-protocol.js";
import { CodingTools } from "./coding-tools.js";
import { computerEnv } from "./computer-env.js";
import { CfStumblePrompt } from "./prompt.js";
import { RepeatedCallNote } from "./repeated-call-note.js";
import { ROUTE_MODEL, routeProvider } from "./route-provider.js";

const CONTEXT_BUDGET_TOKENS = 131_072;

const SETTINGS: HarnessSettings = {
  compaction: {
    reserveTokens: ROUTE_MODEL.contextWindow - CONTEXT_BUDGET_TOKENS + ROUTE_MODEL.maxTokens,
    keepRecentTokens: 20_000,
    backgroundTokens: 0,
  },
};

type Reported = Readonly<{ conversationId: string; run?: SubmissionId | undefined }>;

export type Session = Readonly<{ harness: Harness; host: ConversationHost }>;

export type SessionInput = Readonly<{
  storage: DurableObjectStorage;
  host: ConversationHost;
  generations: GenerationControl | undefined;
  model: ModelCapability;
  abort(reason: string): void;
}>;

export async function openSession(input: SessionInput): Promise<Session> {
  const { host, generations } = input;
  const log = hostLog(host);
  const models = createModels();
  models.setProvider(routeProvider(input.model));
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(CfStumblePrompt);
  registry.install(RepeatedCallNote);

  const harness = await Harness.open(
    await openDurableObjectSqliteStorage(input.storage),
    {
      models,
      registry,
      settings: SETTINGS,
      env: ({ conversationId, cwd }, invocation) =>
        cwd === undefined
          ? undefined
          : computerEnv(host, generations, String(conversationId), cwd, invocation.abortSignal),
      onReport: (report) => {
        log("error", "report", {
          kind: report.kind,
          reason: "reason" in report ? report.reason : null,
          task: "task" in report && report.task !== undefined ? report.task.kind : null,
          ...(report.error instanceof Error
            ? errorFields(report.error)
            : { cause: String(report.error) }),
        });
      },
      onWake: (wake) => {
        void host.arm(wake).catch(() => {
          input.abort("the Supervisor did not arm a wake");
        });
      },
    },
    BACKGROUND_CONTEXT,
  );

  log("info", "session-opened", {});
  void harness.closed.then((end) => {
    if (end.kind === "failed")
      log(
        "error",
        "session-failed",
        end.error instanceof Error ? errorFields(end.error) : { cause: String(end.error) },
      );
    else log("info", "session-closed", {});
  });

  await relayRunningConversations(harness, host, input.abort);

  return { harness, host };
}

async function relayRunningConversations(
  harness: Harness,
  host: ConversationHost,
  abort: (reason: string) => void,
): Promise<void> {
  const graph = await harness.watchTaskGraph(BACKGROUND_CONTEXT);
  let reported = await runningConversations(harness, graph.value);

  await host.running(reported).catch((cause: unknown) => {
    abort("the Supervisor did not take the running conversations");
    throw cause;
  });
  void harness.closed.then((end) => {
    if (end.kind !== "failed" || reported.length === 0) return;

    const failed = Object.fromEntries(
      reported.map((run) => [run.conversationId, "session-failed"]),
    );

    reported = [];
    void host.running([], failed).catch(() => {});
  });
  graph.start(async (call) => {
    if (call.kind !== "value") return;

    const running = await runningConversations(harness, call.value);

    if (JSON.stringify(running) === JSON.stringify(reported)) return;

    const failed = await failedRuns(harness, reported, running);

    reported = running;
    await host.running(running, failed).catch(() => {
      abort("the Supervisor did not take the running conversations");
    });
  });
}

async function failedRuns(
  harness: Harness,
  before: readonly Reported[],
  after: readonly Reported[],
): Promise<RunFailures> {
  const ended = before.filter(
    (run) => !after.some((now) => now.conversationId === run.conversationId && now.run === run.run),
  );

  const records = await Promise.all(
    ended.map(async ({ conversationId, run }) => {
      const submission =
        run === undefined ? undefined : await harness.submission(run, BACKGROUND_CONTEXT);

      return [conversationId, await submission?.status(BACKGROUND_CONTEXT)] as const;
    }),
  );

  return Object.fromEntries(
    records.flatMap(([conversationId, record]) =>
      record?.status === "unanswered" ? [[conversationId, record.reason]] : [],
    ),
  );
}

async function runningConversations(
  harness: Harness,
  graph: TaskGraph,
): Promise<readonly Reported[]> {
  const { submissions } = await harness.inspect(BACKGROUND_CONTEXT);

  const conversations = Object.values(graph.tasks)
    .filter((task) => !task.background)
    .map((task) => task.conversationId);

  return [...new Set(conversations)]
    .toSorted((a, b) => a - b)
    .map((conversationId) => ({
      conversationId: String(conversationId),
      run: submissions.find(
        (submission) =>
          submission.conversationId === conversationId && submission.status === "placed",
      )?.id,
    }));
}
