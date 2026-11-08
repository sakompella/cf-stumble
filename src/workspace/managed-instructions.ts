import * as Effect from "effect/Effect";
import { logRedactedCause } from "../diagnostics.js";
import { MANAGED_AGENT_INSTRUCTIONS_PATH, WORKSPACE_ROOT } from "../workspace-layout.js";
import type { InstructionsWriteResult } from "./commands/index.js";
import { answerFailures, type WorkspaceEffects } from "./operations.js";

export const MANAGED_AGENT_INSTRUCTIONS = [
  "# cf-stumble managed instructions",
  "",
  "cf-stumble rewrites this file before every turn.",
  "Record project conventions in the repository instead; an edit here does not survive.",
  "",
  "Never install dependencies or create large generated trees (node_modules, build output, virtualenvs) inside /workspace.",
  "To run a project's checks, copy the project without its dependency directories to container-local scratch such as /tmp/cf-stumble-checks/<project>, then install dependencies and run the checks there.",
  "For example: mkdir -p /tmp/cf-stumble-checks/<project> && tar -C /workspace/projects/<project> --exclude=node_modules -cf - . | tar -C /tmp/cf-stumble-checks/<project> -xf - && cd /tmp/cf-stumble-checks/<project> && npm install && npm test",
  "The workspace is durable storage, and large trees make it unresponsive.",
  "",
  "`git`, `gh`, and internet access are available. Use them as needed, following the user's request",
  "and the repository's conventions. Never print or commit authentication tokens.",
  "",
].join("\n");

type ManagedInstructionOperations = Pick<WorkspaceEffects, "lstat" | "writeFile">;

export function ensureManagedInstructions(
  operations: ManagedInstructionOperations,
): Effect.Effect<InstructionsWriteResult> {
  const lstat = (path: string) => operations.lstat(path);

  return Effect.gen(function* () {
    for (const path of [WORKSPACE_ROOT, MANAGED_AGENT_INSTRUCTIONS_PATH]) {
      if ((yield* lstat(path)) === "symbolic-link") {
        return { ok: false, error: { code: "path-outside-root" } } as const;
      }
    }

    if ((yield* lstat(MANAGED_AGENT_INSTRUCTIONS_PATH)) === "directory") {
      return { ok: false, error: { code: "workspace-unavailable" } } as const;
    }

    yield* operations.writeFile(MANAGED_AGENT_INSTRUCTIONS_PATH, MANAGED_AGENT_INSTRUCTIONS);

    return { ok: true, result: { kind: "written" } } as const;
  }).pipe(
    answerFailures((cause): InstructionsWriteResult => {
      logRedactedCause("workspace.managed-instructions: workspace-unavailable", cause);

      return { ok: false, error: { code: "workspace-unavailable" } };
    }),
  );
}
