import { parseHarnessCommit, type HarnessCommit } from "../harness-commit.js";
import {
  harnessBuildStep,
  HARNESS_BUILD_STEP_NAMES,
  planHarnessBuild,
  type HarnessBuildConfiguration,
  type HarnessBuildStepName,
} from "../harness-build.js";
import type { WorkspaceFailure, WorkspacePlan } from "./decisions.js";
import { asUntrusted, field, fieldsAreExactly, type UntrustedObject } from "./untrusted.js";

/** A build request whose commit passed `parseHarnessCommit`. Only this form reaches a command. */
export type ParsedHarnessBuildRequest =
  | Readonly<{ kind: "build-step"; harnessCommit: HarnessCommit; step: HarnessBuildStepName }>
  | Readonly<{ kind: "build-output"; harnessCommit: HarnessCommit }>;

function invalidRequest(): WorkspaceFailure {
  return { ok: false, error: { code: "invalid-request" } };
}

function parsedCommit(value: UntrustedObject): HarnessCommit | undefined {
  const harnessCommit = field(value, "harnessCommit");
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: the RPC commit is untrusted.
  return typeof harnessCommit === "string" ? parseHarnessCommit(harnessCommit) : undefined;
}

function parsedStep(value: UntrustedObject): HarnessBuildStepName | undefined {
  const step = field(value, "step");
  return HARNESS_BUILD_STEP_NAMES.find((name) => name === step);
}

/**
 * Parse the build surface's whole RPC input. A caller names a commit and one planned step; command
 * text has no field to arrive in, and an unplanned step is an unknown command.
 */
export function parseHarnessBuildRequest(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the build surface's RPC boundary.
  value: unknown,
): ParsedHarnessBuildRequest | WorkspaceFailure {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: the RPC payload is untrusted.
  if (value === null || typeof value !== "object") return invalidRequest();
  const request = asUntrusted(value);
  const kind = field(request, "kind");
  switch (kind) {
    case "build-step": {
      if (!fieldsAreExactly(request, ["kind", "harnessCommit", "step"])) return invalidRequest();
      const harnessCommit = parsedCommit(request);
      if (harnessCommit === undefined) return invalidRequest();
      const step = parsedStep(request);
      if (step === undefined) return { ok: false, error: { code: "unknown-command" } };
      return { kind, harnessCommit, step };
    }
    case "build-output": {
      if (!fieldsAreExactly(request, ["kind", "harnessCommit"])) return invalidRequest();
      const harnessCommit = parsedCommit(request);
      return harnessCommit === undefined ? invalidRequest() : { kind, harnessCommit };
    }
    default:
      return invalidRequest();
  }
}

/**
 * Decide the one operation a parsed build request performs. Every path it names is derived from
 * the fixed configuration and a validated commit, so no request can reach outside the build root.
 */
export function planHarnessBuildRequest(
  configuration: HarnessBuildConfiguration,
  request: ParsedHarnessBuildRequest,
): WorkspacePlan {
  const plan = planHarnessBuild(configuration, request.harnessCommit);
  if (request.kind === "build-output") {
    return { kind: "read-file", path: plan.moduleMapPath };
  }

  const step = harnessBuildStep(plan, request.step);
  return {
    kind: "run-command",
    source: step.source,
    cwd: step.cwd,
    timeoutMs: configuration.stepTimeoutMs,
  };
}
