import * as Effect from "effect/Effect";
import { logRedactedCause } from "../diagnostics.js";
import { MANAGED_AGENT_INSTRUCTIONS } from "../project-provision.js";
import { MANAGED_AGENT_INSTRUCTIONS_PATH, WORKSPACE_ROOT } from "../workspace-layout.js";
import type { InstructionsWriteResult } from "./decisions.js";
import { answerFailures, attemptWorkspace, type WorkspacePathKind } from "./operations.js";

type ManagedInstructionOperations = Readonly<{
  lstat(path: string): Promise<WorkspacePathKind | undefined>;
  writeFile(path: string, content: string): Promise<void>;
}>;

export function ensureManagedInstructions(
  operations: ManagedInstructionOperations,
): Effect.Effect<InstructionsWriteResult> {
  const lstat = (path: string) => attemptWorkspace(() => operations.lstat(path));

  return Effect.gen(function* () {
    for (const path of [WORKSPACE_ROOT, MANAGED_AGENT_INSTRUCTIONS_PATH]) {
      if ((yield* lstat(path)) === "symbolic-link") {
        return { ok: false, error: { code: "path-outside-root" } } as const;
      }
    }

    if ((yield* lstat(MANAGED_AGENT_INSTRUCTIONS_PATH)) === "directory") {
      return { ok: false, error: { code: "workspace-unavailable" } } as const;
    }

    yield* attemptWorkspace(() =>
      operations.writeFile(MANAGED_AGENT_INSTRUCTIONS_PATH, MANAGED_AGENT_INSTRUCTIONS),
    );

    return { ok: true, result: { kind: "written" } } as const;
  }).pipe(
    answerFailures((cause): InstructionsWriteResult => {
      logRedactedCause("workspace.managed-instructions: workspace-unavailable", cause);

      return { ok: false, error: { code: "workspace-unavailable" } };
    }),
  );
}
