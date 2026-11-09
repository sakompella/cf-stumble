import * as Effect from "effect/Effect";
import type { MainFacetTarget } from "../../facet/index.js";
import type { GenerationControl } from "../../generation-requests.js";
import { WORKSPACE_ROOT } from "../../workspace-layout.js";
import {
  ConversationHostTarget,
  heldWorkspace,
  type ScopedWorkspace,
} from "../conversations/index.js";
import {
  STARTUP_CHECK_MESSAGE,
  STARTUP_CHECK_RESUMED_MESSAGE,
} from "../../startup-check-script.js";
import { candidateCall, scriptedTurn, type ScriptedTurn } from "./turn.js";
import type { StartupCheckOutcome } from "./candidate.js";

const PASSED: StartupCheckOutcome = {
  stage: "ready",
  reason: "the generation answered its startup-check conversation",
};

const failed = (reason: string): StartupCheckOutcome => ({ stage: "conversation-failed", reason });

const freshTurn = (conversationId: string): ScriptedTurn => ({
  conversationId,
  message: STARTUP_CHECK_MESSAGE,
  label: "startup-check",
  answers: 1,
  name: "the startup-check conversation",
});

const resumedTurn = (conversationId: string): ScriptedTurn => ({
  conversationId,
  message: STARTUP_CHECK_RESUMED_MESSAGE,
  label: "startup-check-resumed",
  answers: 2,
  name: "the resumed startup-check conversation",
});

export type ResumeCandidate = () => Effect.Effect<Fetcher<MainFacetTarget>, string>;

export function checkConversation(
  writer: Fetcher<MainFacetTarget>,
  resumeCandidate: ResumeCandidate,
  obtainWorkspace: ScopedWorkspace,
  generations: GenerationControl,
): Effect.Effect<StartupCheckOutcome> {
  const held = heldWorkspace(obtainWorkspace);

  const host = new ConversationHostTarget({
    arm: () => Promise.resolve(),
    log: () => {},
    running: () => Promise.resolve(),
    workspace: async () => {
      const workspace = await held.capability();

      if (workspace === null) throw new Error("the workspace is unavailable");

      return workspace.dup();
    },
  });

  return Effect.gen(function* () {
    yield* candidateCall("the candidate did not attach", () => writer.attach(host, generations));

    const conversationId = yield* candidateCall("the candidate did not open a conversation", () =>
      writer.createConversation(WORKSPACE_ROOT),
    );

    yield* scriptedTurn(writer, freshTurn(conversationId));
    const candidate = yield* resumeCandidate();

    yield* candidateCall("the candidate did not attach", () => candidate.attach(host, generations));
    yield* scriptedTurn(candidate, resumedTurn(conversationId));

    return PASSED;
  }).pipe(
    Effect.catch((reason) => Effect.succeed(failed(reason))),
    Effect.ensuring(held.release),
  );
}
