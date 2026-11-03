import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { MainFacetTarget } from "../../facet/index.js";
import { AssistantMessage, readFirstView, type Conversation } from "../../page/index.js";
import { STARTUP_CHECK_REPLY } from "../../startup-check-script.js";
import { WORKSPACE_ROOT } from "../../workspace-layout.js";
import { ConversationHostTarget, endWorkspaceTurn } from "../conversations/index.js";
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

export function checkConversation(
  candidate: Fetcher<MainFacetTarget>,
  obtainWorkspace: ObtainWorkspace,
): Effect.Effect<StartupCheckOutcome> {
  const released = new AbortController();
  let held: Promise<ProjectCapabilityStub | null> | undefined;

  const host = new ConversationHostTarget({
    arm: () => Promise.resolve(),
    running: () => Promise.resolve(),
    workspace: async () => {
      held ??= Effect.runPromise(obtainWorkspace(released.signal));
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
    yield* candidateCall(() => candidate.attach(host));
    const conversationId = yield* candidateCall(() => candidate.createConversation(WORKSPACE_ROOT));
    yield* candidateCall(() => candidate.submit(conversationId, PROBE_MESSAGE, "startup-check"));
    const answer = yield* settledAnswer(candidate, conversationId);
    const text = answerText(answer);

    return answer.stopReason === "stop" && text === STARTUP_CHECK_REPLY
      ? PASSED
      : failed(`the startup-check conversation ended with ${answer.stopReason}: ${text}`);
  }).pipe(
    Effect.catch((reason) => Effect.succeed(failed(reason))),
    Effect.ensuring(release),
  );
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
): Effect.Effect<AssistantMessage, string> {
  return candidateCall(() => snapshotLine(candidate, conversationId)).pipe(
    Effect.flatMap((line) => {
      const conversation = readFirstView(line);

      if (Option.isNone(conversation)) {
        return Effect.fail("the startup-check conversation did not open with a readable view");
      }

      const answer = finalAnswer(conversation.value);

      return answer === undefined
        ? Effect.sleep(POLL_MS).pipe(Effect.andThen(settledAnswer(candidate, conversationId)))
        : Effect.succeed(answer);
    }),
  );
}

async function snapshotLine(
  candidate: Fetcher<MainFacetTarget>,
  conversationId: string,
): Promise<string> {
  const events = await candidate.events(conversationId);
  const reader = events.pipeThrough(new TextDecoderStream()).getReader();
  let read = "";

  try {
    while (!read.includes("\n")) {
      const next = await reader.read();

      if (next.done) return read;
      read += next.value;
    }
  } finally {
    await reader.cancel();
  }

  return read.slice(0, read.indexOf("\n"));
}

function finalAnswer(conversation: Conversation): AssistantMessage | undefined {
  if (conversation.isRunning) return undefined;

  const last = conversation.items
    .flatMap((item) => (item.kind === "entry" ? (item.entry.model ?? []) : []))
    .at(-1);

  return isAssistantMessage(last) && last.stopReason !== "toolUse" ? last : undefined;
}

function answerText(answer: AssistantMessage): string {
  const text = answer.content.flatMap((block) => ("text" in block ? [block.text] : [])).join("");

  return text === "" ? (answer.errorMessage ?? "") : text;
}
