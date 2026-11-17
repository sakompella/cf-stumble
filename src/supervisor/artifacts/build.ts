import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  isRetryableFailure,
  isTimeoutFailure,
  logRedactedCause,
  redactLogText,
} from "../../diagnostics.js";
import { ModuleMapSchema, parseMainHarnessArtifact } from "../../facet/index.js";
import type { MainHarnessArtifact, MainHarnessArtifactProblem } from "../../facet/index.js";
import { HARNESS_BUILD_STEP_NAMES } from "../../harness-build.js";
import type { HarnessBuildStepName } from "../../harness-build.js";
import type { HarnessCommit } from "../../harness-commit.js";
import {
  boundedRpc,
  WORKSPACE_RPC_TIMEOUT_MS,
  WorkspaceRpcRejected,
  type WorkspaceRpcFailure,
} from "../../workspace-command-timeout.js";
import type { CommandAnswer, CommandOutput, WorkspaceHostRpc } from "../../workspace/index.js";

export type BuildWorkspace = WorkspaceHostRpc<"build" | "buildOutput" | "discardBuild">;

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

const decodeBuiltModuleMap = Schema.decodeUnknownResult(Schema.fromJsonString(ModuleMapSchema));

class WorkspaceRestarted extends Data.TaggedError("WorkspaceRestarted")<{
  readonly message: string;
}> {}

export function buildModuleMap(
  workspace: () => BuildWorkspace,
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
    Effect.retry({ times: 1, while: (failure) => failure instanceof WorkspaceRestarted }),
    Effect.mapError((failure): HarnessBuildProblem =>
      failure instanceof WorkspaceRestarted
        ? { code: "build-workspace-unavailable", harnessCommit }
        : failure,
    ),
  );
}

function discardScratch(
  workspace: () => BuildWorkspace,
  harnessCommit: HarnessCommit,
): Effect.Effect<void> {
  return command(() => workspace().discardBuild(harnessCommit), "the scratch cleanup").pipe(
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

function rejectedCall(error: WorkspaceRpcFailure): WorkspaceRpcFailure | WorkspaceRestarted {
  return error instanceof WorkspaceRpcRejected && isRetryableFailure(error.cause)
    ? new WorkspaceRestarted({ message: error.message })
    : error;
}

function refusal(code: string, refused: string): BuildWorkspaceRefused | WorkspaceRestarted {
  return code === "workspace-restarted"
    ? new WorkspaceRestarted({ message: `the build workspace restarted during ${refused}` })
    : new BuildWorkspaceRefused({ message: `the build workspace refused ${refused}: ${code}` });
}

function command(call: () => Promise<CommandAnswer>, label: string) {
  return boundedRpc(call, WORKSPACE_RPC_TIMEOUT_MS).pipe(
    Effect.mapError(rejectedCall),
    Effect.flatMap((answer) =>
      answer.ok ? Effect.succeed(answer.output) : Effect.fail(refusal(answer.error.code, label)),
    ),
  );
}

function moduleMapText(workspace: () => BuildWorkspace, harnessCommit: HarnessCommit) {
  return boundedRpc(() => workspace().buildOutput(harnessCommit), WORKSPACE_RPC_TIMEOUT_MS).pipe(
    Effect.mapError(rejectedCall),
    Effect.flatMap((answer) => {
      if (answer.ok) return Effect.succeed(answer.moduleMap);

      return Effect.fail(
        answer.error.code === "publish-failed"
          ? new BuildWorkspaceRefused({
              message: "the build wrote no readable module map: the publish step failed",
            })
          : refusal(answer.error.code, "the build output"),
      );
    }),
  );
}

function runStep(
  workspace: () => BuildWorkspace,
  harnessCommit: HarnessCommit,
  step: HarnessBuildStepName,
): Effect.Effect<void, HarnessBuildProblem | WorkspaceRestarted> {
  const ran = command(() => workspace().build({ harnessCommit, step }), `the ${step} step`).pipe(
    Effect.mapError((error): HarnessBuildProblem | WorkspaceRestarted => {
      if (error instanceof WorkspaceRestarted) {
        logRedactedCause(`harness-build.${step}: workspace-restarted`, error);

        return error;
      }

      const reason = isTimeoutFailure(error) ? "timeout" : "build-workspace-unavailable";
      logRedactedCause(`harness-build.${step}: ${reason}`, error);

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
  workspace: () => BuildWorkspace,
  harnessCommit: HarnessCommit,
): Effect.Effect<MainHarnessArtifact, HarnessBuildProblem | WorkspaceRestarted> {
  const text = moduleMapText(workspace, harnessCommit).pipe(
    Effect.mapError((error): HarnessBuildProblem | WorkspaceRestarted => {
      if (error instanceof WorkspaceRestarted) {
        logRedactedCause(`harness-build.output ${harnessCommit}: workspace-restarted`, error);

        return error;
      }

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
    : parseMainHarnessArtifact({ harnessCommit, ...output.success });

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
