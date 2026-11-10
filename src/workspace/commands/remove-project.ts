import * as Effect from "effect/Effect";
import { WORKSPACE_COMMAND_TIMEOUT_MS } from "../../workspace-command-timeout.js";
import { parseProjectId, type ProjectId } from "../../project-catalog.js";
import { HARNESS_PROJECT_ID } from "../../selectable-projects.js";
import { shellQuote } from "../../shell-quote.js";
import { type WorkspaceEffects } from "../operations.js";
import { holdProvisionLock } from "./clone-script.js";
import { projectProvisionLockPath } from "./provision-project.js";
import { removedDirectories, removedFromStore } from "./remove-project-store.js";
import {
  answerDurableFailures,
  commandResult,
  invalidRequest,
  syncIncomplete,
  type WorkspaceCommandResult,
  type WorkspaceFailure,
  type WorkspacePlan,
} from "./command-result.js";

export type ProjectRemovalRequest = Readonly<{
  kind: "remove-project";
  projectId: string;
}>;

type ParsedProjectRemovalRequest = Readonly<{
  kind: "remove-project";
  projectId: ProjectId;
}>;

export function parseProjectRemovalRequest(
  request: ProjectRemovalRequest,
): ParsedProjectRemovalRequest | WorkspaceFailure {
  const projectId = parseProjectId(request.projectId);

  return projectId === undefined || projectId === HARNESS_PROJECT_ID
    ? invalidRequest()
    : { kind: "remove-project", projectId };
}

export function planProjectRemovalRequest(
  request: ParsedProjectRemovalRequest,
): Extract<WorkspacePlan, { kind: "run-command" }> {
  const removed = removedDirectories(request.projectId).map((path) => shellQuote(path));

  return {
    kind: "run-command",
    source: [
      "set -eu",
      `lock=${shellQuote(projectProvisionLockPath(request.projectId))}`,
      ...holdProvisionLock(),
      `rm -rf -- ${removed.join(" ")}`,
    ].join("\n"),
    cwd: "/",
    timeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS,
  };
}

export function executeProjectRemovalRequest(
  input: Readonly<{
    operations: WorkspaceEffects;
    request: ProjectRemovalRequest;
  }>,
): Effect.Effect<WorkspaceCommandResult> {
  const parsed = parseProjectRemovalRequest(input.request);

  if ("ok" in parsed) return Effect.succeed(parsed);

  return Effect.gen(function* () {
    const { operations } = input;
    const plan = planProjectRemovalRequest(parsed);
    const output = yield* operations.runCommand(plan.source, plan.cwd, plan.timeoutMs);

    if (output.exitCode === 0 && !(yield* removedFromStore(operations, parsed.projectId))) {
      return syncIncomplete();
    }

    return commandResult(output);
  }).pipe(answerDurableFailures("workspace.project-removal", () => "workspace-unavailable"));
}
