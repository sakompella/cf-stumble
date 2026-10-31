import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { isTimeoutFailure, logRedactedCause, redactLogText } from "../../diagnostics.js";
import { MainHarnessArtifact } from "../../facet/index.js";
import type { MainHarnessArtifactProblem } from "../../facet/index.js";
import { HARNESS_BUILD_STEP_NAMES } from "../../harness-build.js";
import type { HarnessBuildRequest, HarnessBuildStepName } from "../../harness-build.js";
import type { HarnessCommit } from "../../harness-commit.js";
import { boundedRpc, WORKSPACE_RPC_TIMEOUT_MS } from "../../workspace-command-timeout.js";
import type { CommandOutput, WorkspaceCommandResult } from "../../workspace/index.js";

export type BuildWorkspaceHost = Readonly<{
  build(request: HarnessBuildRequest): Promise<WorkspaceCommandResult>;
}>;

export type BuildWorkspaceNamespace = Readonly<{
  getByName(name: string): BuildWorkspaceHost;
}>;

export type BuildStepDiagnostics = Readonly<{
  stdoutTail: string;
  stderrTail: string;
  truncated: boolean;
}>;

export type HarnessBuildProblem =
  | { readonly code: "build-workspace-unavailable"; readonly harnessCommit: string }
  | {
      readonly code: "build-step-failed";
      readonly harnessCommit: string;
      readonly step: HarnessBuildStepName;
      readonly exitCode: number;
      readonly diagnostics: BuildStepDiagnostics;
    }
  | { readonly code: "build-output-missing"; readonly harnessCommit: string }
  | {
      readonly code: "build-output-invalid";
      readonly harnessCommit: string;
      readonly reason: MainHarnessArtifactProblem["code"];
    };

const decodeBuiltModuleMap = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      entryModule: Schema.String,
      modules: Schema.Array(Schema.Struct({ name: Schema.String, source: Schema.String })),
    }),
  ),
);

export function buildModuleMap(
  workspace: () => BuildWorkspaceHost,
  harnessCommit: HarnessCommit,
): Effect.Effect<MainHarnessArtifact, HarnessBuildProblem> {
  const steps = Effect.forEach(
    HARNESS_BUILD_STEP_NAMES,
    (step) => runStep(workspace, harnessCommit, step),
    { discard: true },
  );

  return steps.pipe(Effect.andThen(readModuleMap(workspace, harnessCommit)));
}

async function command(
  workspace: () => BuildWorkspaceHost,
  request: HarnessBuildRequest,
  label: string,
): Promise<CommandOutput> {
  const result = await boundedRpc(() => workspace().build(request), WORKSPACE_RPC_TIMEOUT_MS);

  if (!result.ok) {
    throw new Error(`the build workspace refused ${label}: ${result.error.code}`);
  }

  const { stdout, stderr, exitCode } = result.result;

  return { stdout, stderr, exitCode };
}

function runStep(
  workspace: () => BuildWorkspaceHost,
  harnessCommit: HarnessCommit,
  step: HarnessBuildStepName,
): Effect.Effect<void, HarnessBuildProblem> {
  const ran = Effect.tryPromise({
    try: () => command(workspace, { kind: "build-step", harnessCommit, step }, `the ${step} step`),
    catch: (error): HarnessBuildProblem => {
      logRedactedCause(
        `harness-build.${step}: ${isTimeoutFailure(error) ? "timeout" : "build-workspace-unavailable"}`,
        error,
      );

      return { code: "build-workspace-unavailable", harnessCommit };
    },
  });

  return ran.pipe(
    Effect.flatMap((output) =>
      output.exitCode === 0
        ? Effect.void
        : Effect.fail<HarnessBuildProblem>({
            code: "build-step-failed",
            harnessCommit,
            step,
            exitCode: output.exitCode,
            diagnostics: stepDiagnostics(output),
          }),
    ),
  );
}

async function moduleMapText(
  workspace: () => BuildWorkspaceHost,
  harnessCommit: HarnessCommit,
): Promise<string> {
  const output = await command(
    workspace,
    { kind: "build-output", harnessCommit },
    "the build output",
  );

  if (output.exitCode !== 0) {
    throw new Error(`the build wrote no readable module map: exit ${output.exitCode}`);
  }

  return output.stdout;
}

function readModuleMap(
  workspace: () => BuildWorkspaceHost,
  harnessCommit: HarnessCommit,
): Effect.Effect<MainHarnessArtifact, HarnessBuildProblem> {
  const text = Effect.tryPromise({
    try: () => moduleMapText(workspace, harnessCommit),
    catch: (error): HarnessBuildProblem => {
      logRedactedCause(`harness-build.output ${harnessCommit}: build-output-missing`, error);

      return { code: "build-output-missing", harnessCommit };
    },
  });

  return text.pipe(
    Effect.flatMap((built) => Effect.fromResult(parsedOutput(harnessCommit, built))),
  );
}

function parsedOutput(
  harnessCommit: HarnessCommit,
  text: string,
): Result.Result<MainHarnessArtifact, HarnessBuildProblem> {
  const output = decodeBuiltModuleMap(text);

  const parsed = Result.isFailure(output)
    ? Result.fail<MainHarnessArtifactProblem>({ code: "invalid-artifact" })
    : MainHarnessArtifact.parse({ harnessCommit, ...output.success });

  return Result.mapError(parsed, (problem) => ({
    code: "build-output-invalid",
    harnessCommit,
    reason: problem.code,
  }));
}

const DIAGNOSTIC_TAIL_LIMIT = 2_000;

function lastUnits(text: string): string {
  const tail = text.slice(-DIAGNOSTIC_TAIL_LIMIT);
  const first = tail.codePointAt(0) ?? 0;

  const cut = text.length > DIAGNOSTIC_TAIL_LIMIT;

  return cut && first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
}

function stepDiagnostics(output: CommandOutput): BuildStepDiagnostics {
  const stdout = redactLogText(output.stdout);
  const stderr = redactLogText(output.stderr);

  return {
    stdoutTail: lastUnits(stdout),
    stderrTail: lastUnits(stderr),
    truncated: stdout.length > DIAGNOSTIC_TAIL_LIMIT || stderr.length > DIAGNOSTIC_TAIL_LIMIT,
  };
}
