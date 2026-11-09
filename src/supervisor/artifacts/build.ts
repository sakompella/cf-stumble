import * as Data from "effect/Data";
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
import type { CommandOutput, WorkspaceHostRpc } from "../../workspace/index.js";

type BuildStepDiagnostics = Readonly<{
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
  workspace: () => WorkspaceHostRpc<"build">,
  harnessCommit: HarnessCommit,
): Effect.Effect<MainHarnessArtifact, HarnessBuildProblem> {
  const steps = Effect.forEach(
    HARNESS_BUILD_STEP_NAMES,
    (step) => runStep(workspace, harnessCommit, step),
    { discard: true },
  );

  return steps.pipe(
    Effect.andThen(readModuleMap(workspace, harnessCommit)),
    Effect.ensuring(discardScratch(workspace, harnessCommit)),
  );
}

function discardScratch(
  workspace: () => WorkspaceHostRpc<"build">,
  harnessCommit: HarnessCommit,
): Effect.Effect<void> {
  return command(workspace, { kind: "build-discard", harnessCommit }, "the scratch cleanup").pipe(
    Effect.flatMap((output) =>
      output.exitCode === 0
        ? Effect.void
        : Effect.fail(
            new BuildWorkspaceRefused({
              message: `the scratch cleanup exited ${output.exitCode}: ${lastUnits(redactLogText(output.stderr))}`,
            }),
          ),
    ),
    Effect.mapError((error) => {
      logRedactedCause(`harness-build.discard ${harnessCommit}: scratch-left-behind`, error);
    }),
    Effect.ignore,
  );
}

class BuildWorkspaceRefused extends Data.TaggedError("BuildWorkspaceRefused")<{
  readonly message: string;
}> {}

function command(
  workspace: () => WorkspaceHostRpc<"build">,
  request: HarnessBuildRequest,
  label: string,
): Effect.Effect<CommandOutput, unknown> {
  return boundedRpc(() => workspace().build(request), WORKSPACE_RPC_TIMEOUT_MS).pipe(
    Effect.flatMap((result) => {
      if (!result.ok) {
        return Effect.fail(
          new BuildWorkspaceRefused({
            message: `the build workspace refused ${label}: ${result.error.code}`,
          }),
        );
      }

      if (result.result.kind !== "command") {
        return Effect.fail(
          new BuildWorkspaceRefused({
            message: `the build workspace answered ${label} with a ${result.result.kind} result`,
          }),
        );
      }

      const { stdout, stderr, exitCode } = result.result;

      return Effect.succeed({ stdout, stderr, exitCode });
    }),
  );
}

function moduleMapText(
  workspace: () => WorkspaceHostRpc<"build">,
  harnessCommit: HarnessCommit,
): Effect.Effect<string, unknown> {
  return boundedRpc(
    () => workspace().build({ kind: "build-output", harnessCommit }),
    WORKSPACE_RPC_TIMEOUT_MS,
  ).pipe(
    Effect.flatMap((result) => {
      if (!result.ok) {
        return Effect.fail(
          new BuildWorkspaceRefused({
            message: `the build workspace refused the build output: ${result.error.code}`,
          }),
        );
      }

      if (result.result.kind === "module-map") return Effect.succeed(result.result.text);

      return Effect.fail(
        new BuildWorkspaceRefused({
          message: "the build wrote no readable module map: the publish step failed",
        }),
      );
    }),
  );
}

function runStep(
  workspace: () => WorkspaceHostRpc<"build">,
  harnessCommit: HarnessCommit,
  step: HarnessBuildStepName,
): Effect.Effect<void, HarnessBuildProblem> {
  const ran = command(
    workspace,
    { kind: "build-step", harnessCommit, step },
    `the ${step} step`,
  ).pipe(
    Effect.mapError((error): HarnessBuildProblem => {
      logRedactedCause(
        `harness-build.${step}: ${isTimeoutFailure(error) ? "timeout" : "build-workspace-unavailable"}`,
        error,
      );

      return { code: "build-workspace-unavailable", harnessCommit };
    }),
  );

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

function readModuleMap(
  workspace: () => WorkspaceHostRpc<"build">,
  harnessCommit: HarnessCommit,
): Effect.Effect<MainHarnessArtifact, HarnessBuildProblem> {
  const text = moduleMapText(workspace, harnessCommit).pipe(
    Effect.mapError((error): HarnessBuildProblem => {
      logRedactedCause(`harness-build.output ${harnessCommit}: build-output-missing`, error);

      return { code: "build-output-missing", harnessCommit };
    }),
  );

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
