import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { MainHarnessArtifactInput } from "../../facet/index.js";
import type { HarnessCommit } from "../../harness-commit.js";
import type { CommandOutput } from "../../workspace/index.js";
import {
  isTimeoutFailure,
  logCommit,
  logRedactedCause,
  redactLogText,
  timedEffect,
  type TimedOutcome,
} from "../../diagnostics.js";
import {
  moduleMapFromBuildOutput,
  planHarnessBuild,
  type BuildStepDiagnostics,
  type BuiltModuleMapFile,
  type HarnessBuildConfiguration,
  type HarnessBuildProblem,
  type HarnessBuildStep,
} from "./build-plan.js";

/** A build of one labeled commit: its validated module map, or why there is none. */
export type HarnessBuild = Effect.Effect<MainHarnessArtifactInput, HarnessBuildProblem>;

/** How the resolver asks for a module map it does not have. */
export type HarnessModuleMapBuilder = Readonly<{
  build(harnessCommit: HarnessCommit): HarnessBuild;
}>;

/**
 * The only operations a build needs from its workspace. It stays narrower than the operations the
 * project capability offers: a build runs its planned steps and reads its own module map, nothing
 * else.
 */
export type BuildWorkspace = Readonly<{
  runStep(step: HarnessBuildStep): Promise<CommandOutput>;
  readModuleMap(): Promise<string>;
}>;

/** Builds a labeled harness commit in the scratch subtree kept apart from every repository. */
export class WorkspaceModuleMapBuilder implements HarnessModuleMapBuilder {
  private readonly workspace: BuildWorkspace;
  private readonly configuration: HarnessBuildConfiguration;

  constructor(workspace: BuildWorkspace, configuration: HarnessBuildConfiguration) {
    this.workspace = workspace;
    this.configuration = configuration;
  }

  /** The planned steps one after another, then the module map they wrote. */
  build(harnessCommit: HarnessCommit): HarnessBuild {
    const plan = planHarnessBuild(this.configuration, harnessCommit);
    const commit = logCommit(harnessCommit);

    const steps = Effect.forEach(
      plan.steps,
      (step) =>
        this.runStep(step, harnessCommit).pipe(
          timedEffect("harness-build.step", { commit, step: step.name }, buildOutcome),
        ),
      { discard: true },
    );

    const output = this.readModuleMap(plan.moduleMapPath, harnessCommit).pipe(
      timedEffect("harness-build.output", { commit }, buildOutcome),
    );

    return steps.pipe(Effect.andThen(output));
  }

  private runStep(
    step: HarnessBuildStep,
    harnessCommit: HarnessCommit,
  ): Effect.Effect<CommandOutput, HarnessBuildProblem> {
    const ran = Effect.tryPromise({
      try: () => this.workspace.runStep(step),
      catch: (error): HarnessBuildProblem => {
        // `build-workspace-unavailable` says nothing about which of the workspace, the container
        // or the connection to them gave way, and each of those failed at least once during this
        // project's deployed builds.
        logRedactedCause(
          `harness-build.${step.name}: ${isTimeoutFailure(error) ? "timeout" : "build-workspace-unavailable"}`,
          error,
        );

        return { code: "build-workspace-unavailable", harnessCommit };
      },
    });

    // The tail of a failed step's own output is the only account of why the build failed, and it
    // exists nowhere else once the build directory is cleared. It goes to the owner in the
    // submission response and is not logged: command output can hold file contents. The log keeps
    // the step, the exit code, and the duration (`buildOutcome`).
    return ran.pipe(
      Effect.flatMap((output) =>
        output.exitCode === 0
          ? Effect.succeed(output)
          : Effect.fail<HarnessBuildProblem>({
              code: "build-step-failed",
              harnessCommit,
              step: step.name,
              exitCode: output.exitCode,
              diagnostics: stepDiagnostics(output),
            }),
      ),
    );
  }

  private readModuleMap(path: string, harnessCommit: HarnessCommit): HarnessBuild {
    const encoded = Effect.tryPromise({
      try: () => this.workspace.readModuleMap(),
      catch: (error): HarnessBuildProblem => {
        logRedactedCause(`harness-build.output ${path}: build-output-missing`, error);

        return { code: "build-output-missing", harnessCommit };
      },
    });

    return encoded.pipe(
      Effect.flatMap((text) =>
        Effect.tryPromise({
          // `Response.json` decodes without asserting a type the build has not proved yet;
          // `moduleMapFromBuildOutput` validates the decoded value.
          try: () => new Response(text).json<BuiltModuleMapFile>(),
          catch: (): HarnessBuildProblem => ({
            code: "build-output-invalid",
            harnessCommit,
            reason: "invalid-artifact",
          }),
        }),
      ),
      Effect.flatMap((output) =>
        Effect.fromResult(moduleMapFromBuildOutput(harnessCommit, output)),
      ),
    );
  }
}

const DIAGNOSTIC_TAIL_LIMIT = 2_000;

/** The last `DIAGNOSTIC_TAIL_LIMIT` UTF-16 units, without a surrogate pair cut in half. */
function lastUnits(text: string): string {
  const tail = text.slice(-DIAGNOSTIC_TAIL_LIMIT);
  const first = tail.codePointAt(0) ?? 0;

  const cut = text.length > DIAGNOSTIC_TAIL_LIMIT;

  return cut && first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
}

/** The redacted tail of each stream. Redaction runs first: a cut could leave half a token. */
function stepDiagnostics(output: CommandOutput): BuildStepDiagnostics {
  const stdout = redactLogText(output.stdout);
  const stderr = redactLogText(output.stderr);

  return {
    stdoutTail: lastUnits(stdout),
    stderrTail: lastUnits(stderr),
    truncated: stdout.length > DIAGNOSTIC_TAIL_LIMIT || stderr.length > DIAGNOSTIC_TAIL_LIMIT,
  };
}

/** A build step's log outcome: `ok`, or the problem code and, for a failed command, its exit code. */
function buildOutcome<Value>(ran: Result.Result<Value, HarnessBuildProblem>): TimedOutcome {
  if (Result.isSuccess(ran)) return { outcome: "ok" };

  const problem = ran.failure;

  return {
    outcome: problem.code,
    level: "warn",
    fields: problem.code === "build-step-failed" ? { exitCode: problem.exitCode } : {},
  };
}
