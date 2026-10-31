import { parseHarnessCommit, type HarnessCommit } from "../harness-commit.js";
import {
  harnessBuildStep,
  planHarnessBuild,
  type HarnessBuildConfiguration,
  type HarnessBuildPlan,
  type HarnessBuildRequest,
  type HarnessBuildStepName,
} from "../harness-build.js";
import { shellQuote } from "../shell-quote.js";
import type { WorkspaceFailure, WorkspacePlan } from "./decisions.js";
import { WORKSPACE_ROOT } from "../workspace-layout.js";

type ParsedHarnessBuildRequest =
  | Readonly<{ kind: "build-step"; harnessCommit: HarnessCommit; step: HarnessBuildStepName }>
  | Readonly<{ kind: "build-output"; harnessCommit: HarnessCommit }>;

function invalidRequest(): WorkspaceFailure {
  return { ok: false, error: { code: "invalid-request" } };
}

export function parseHarnessBuildRequest(
  request: HarnessBuildRequest,
): ParsedHarnessBuildRequest | WorkspaceFailure {
  const harnessCommit = parseHarnessCommit(request.harnessCommit);

  if (harnessCommit === undefined) return invalidRequest();

  return request.kind === "build-step"
    ? { kind: "build-step", harnessCommit, step: request.step }
    : { kind: "build-output", harnessCommit };
}

function readModuleMapSource(plan: HarnessBuildPlan): string {
  return [
    "set -eu",
    `path=${shellQuote(plan.moduleMapPath)}`,
    'if [ -L "$path" ]; then',
    '  echo "the module map path is a symbolic link" >&2',
    "  exit 3",
    "fi",
    'cat -- "$path"',
  ].join("\n");
}

export function planHarnessBuildRequest(
  configuration: HarnessBuildConfiguration,
  request: ParsedHarnessBuildRequest,
): WorkspacePlan {
  const plan = planHarnessBuild(configuration, request.harnessCommit);

  if (request.kind === "build-output") {
    return {
      kind: "run-command",
      source: readModuleMapSource(plan),
      cwd: WORKSPACE_ROOT,
      timeoutMs: configuration.stepTimeoutMs,
    };
  }

  const step = harnessBuildStep(plan, request.step);

  return {
    kind: "run-command",
    source: step.source,
    cwd: step.cwd,
    timeoutMs: configuration.stepTimeoutMs,
  };
}
