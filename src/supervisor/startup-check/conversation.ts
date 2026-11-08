import * as Effect from "effect/Effect";
import type { MainFacetTarget } from "../../facet/index.js";
import type { GenerationControl } from "../../generation-requests.js";
import { runAtEntryPoint } from "../../run-entry-point.js";
import { WORKSPACE_ROOT } from "../../workspace-layout.js";
import { ConversationHostTarget, endWorkspaceTurn } from "../conversations/index.js";
import type { ProjectCapabilityStub } from "../../workspace/index.js";
import {
  STARTUP_CHECK_MESSAGE,
  STARTUP_CHECK_RESUMED_MESSAGE,
} from "../../startup-check-script.js";
import { candidateCall, scriptedTurn } from "./turn.js";
import type { StartupCheckOutcome } from "./candidate.js";

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
  generations: GenerationControl,
): Effect.Effect<StartupCheckOutcome> {
  const released = new AbortController();
  let held: Promise<ProjectCapabilityStub | null> | undefined;

  const host = new ConversationHostTarget({
    arm: () => Promise.resolve(),
    log: () => {},
    running: () => Promise.resolve(),
    workspace: async () => {
      held ??= runAtEntryPoint(obtainWorkspace(released.signal));
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
    yield* candidateCall(() => writer.attach(host, generations));
    const conversationId = yield* candidateCall(() => writer.createConversation(WORKSPACE_ROOT));

    yield* scriptedTurn(writer, {
      conversationId,
      message: STARTUP_CHECK_MESSAGE,
      label: "startup-check",
      answers: 1,
      name: "the startup-check conversation",
    });
    const candidate = yield* resumeCandidate();

    yield* candidateCall(() => candidate.attach(host, generations));
    yield* scriptedTurn(candidate, {
      conversationId,
      message: STARTUP_CHECK_RESUMED_MESSAGE,
      label: "startup-check-resumed",
      answers: 2,
      name: "the resumed startup-check conversation",
    });

    return PASSED;
  }).pipe(
    Effect.catch((reason) => Effect.succeed(failed(reason))),
    Effect.ensuring(release),
  );
}
