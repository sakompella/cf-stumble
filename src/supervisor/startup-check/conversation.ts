import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { MainFacetTarget } from "../../facet/index.js";
import { AssistantMessage, readFirstView, type Conversation } from "../../page/index.js";
import { STARTUP_CHECK_REPLY } from "../../startup-check-script.js";
import { WORKSPACE_ROOT } from "../../workspace-layout.js";
import { ConversationHostTarget, endWorkspaceTurn, runAtPort } from "../conversations/index.js";
import type { ProjectCapabilityStub } from "../projects/index.js";
import type { StartupCheckOutcome } from "./candidate.js";

const PROBE_MESSAGE = "Run the startup check.";

const POLL_MS = 100;

const isAssistantMessage = Schema.is(AssistantMessage);

const PASSED: StartupCheckOutcome = {
  stage: "ready",
  reason: "the generation answered its startup-check conversation",
};

const failed = (reason: string): StartupCheckOutcome => ({ stage: "conversation-failed", reason });

type ObtainWorkspace = (signal: AbortSignal) => Effect.Effect<ProjectCapabilityStub | null>;

export type ResumeCandidate = () => Effect.Effect<Fetcher<MainFacetTarget>, string>;

export function checkConversation(
  writer: Fetcher<MainFacetTarget>,
  resumeCandidate: ResumeCandidate,
  obtainWorkspace: ObtainWorkspace,
): Effect.Effect<StartupCheckOutcome> {
  const released = new AbortController();
  let held: Promise<ProjectCapabilityStub | null> | undefined;

  const host = new ConversationHostTarget({
    arm: () => Promise.resolve(),
    log: () => {},
    running: () => Promise.resolve(),
    workspace: async () => {
      held ??= runAtPort(obtainWorkspace(released.signal));
      const workspace = await held;

      if (workspace === null) throw new Error("the workspace is unavailable");

      return workspace.dup();
    },
  });

  const release = Effect.sync(() => {
    released.abort();
    void held?.then((workspace) => {
      if (workspace !== null) endWorkspaceTurn(workspace);
    });
  });

  return Effect.gen(function* () {
    yield* candidateCall(() => writer.attach(host));
    const conversationId = yield* candidateCall(() => writer.createConversation(WORKSPACE_ROOT));
    yield* candidateCall(() => writer.submit(conversationId, PROBE_MESSAGE, "startup-check"));
    const first = yield* settledAnswer(writer, conversationId, 1);

    if (!isReply(first))
      return failed(`the startup-check conversation ended with ${describe(first)}`);

    const candidate = yield* resumeCandidate();

    yield* candidateCall(() => candidate.attach(host));
    yield* candidateCall(() =>
      candidate.submit(conversationId, PROBE_MESSAGE, "startup-check-resumed"),
    );
    const second = yield* settledAnswer(candidate, conversationId, 2);

    return isReply(second)
      ? PASSED
      : failed(`the resumed startup-check conversation ended with ${describe(second)}`);
  }).pipe(
    Effect.catch((reason) => Effect.succeed(failed(reason))),
    Effect.ensuring(release),
  );
}

function isReply(answer: AssistantMessage): boolean {
  return answer.stopReason === "stop" && answerText(answer) === STARTUP_CHECK_REPLY;
}

function describe(answer: AssistantMessage): string {
  return `${answer.stopReason}: ${answerText(answer)}`;
}

function candidateCall<T>(call: () => Promise<T>): Effect.Effect<T, string> {
  return Effect.tryPromise({
    try: call,
    catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
  });
}

function settledAnswer(
  candidate: Fetcher<MainFacetTarget>,
  conversationId: string,
  answers: number,
): Effect.Effect<AssistantMessage, string> {
  return snapshotLine(candidate, conversationId).pipe(
    Effect.flatMap((line) => {
      const conversation = readFirstView(line);

      if (Option.isNone(conversation)) {
        return Effect.fail("the startup-check conversation did not open with a readable view");
      }

      const answer = finalAnswer(conversation.value, answers);

      return answer === undefined
        ? Effect.sleep(POLL_MS).pipe(
            Effect.andThen(settledAnswer(candidate, conversationId, answers)),
          )
        : Effect.succeed(answer);
    }),
  );
}

function snapshotLine(
  candidate: Fetcher<MainFacetTarget>,
  conversationId: string,
): Effect.Effect<string, string> {
  return Effect.scoped(
    Effect.gen(function* () {
      const events = yield* candidateCall(() => candidate.events(conversationId));

      const reader = yield* Effect.acquireRelease(
        Effect.sync(() => events.pipeThrough(new TextDecoderStream()).getReader()),
        (opened) => Effect.promise(() => opened.cancel()),
      );

      let read = "";

      while (!read.includes("\n")) {
        const next = yield* candidateCall(() => reader.read());

        if (next.done) return read;
        read += next.value;
      }

      return read.slice(0, read.indexOf("\n"));
    }),
  );
}

function finalAnswer(conversation: Conversation, answers: number): AssistantMessage | undefined {
  if (conversation.isRunning) return undefined;

  const messages = conversation.items.flatMap((item) =>
    item.kind === "entry" ? (item.entry.model ?? []) : [],
  );

  const final = messages.filter(
    (message) => isAssistantMessage(message) && message.stopReason !== "toolUse",
  );

  const last = messages.at(-1);

  return final.length >= answers && isAssistantMessage(last) && last.stopReason !== "toolUse"
    ? last
    : undefined;
}

function answerText(answer: AssistantMessage): string {
  const text = answer.content.flatMap((block) => ("text" in block ? [block.text] : [])).join("");

  return text === "" ? (answer.errorMessage ?? "") : text;
}
