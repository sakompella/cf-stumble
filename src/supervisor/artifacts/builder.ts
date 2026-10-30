import * as Effect from "effect/Effect";
import type { MainHarnessArtifactInput } from "../../facet/index.js";
import type { HarnessCommit } from "../../harness-commit.js";
import type { CommandOutput } from "../../workspace/index.js";
import { isTimeoutFailure, logRedactedCause, redactLogText } from "../../diagnostics.js";
import {
  moduleMapFromBuildOutput,
  planHarnessBuild,
  type BuildStepDiagnostics,
  type BuiltModuleMapFile,
  type HarnessBuildConfiguration,
  type HarnessBuildProblem,
  type HarnessBuildStep,
} from "./build-plan.js";

export type HarnessBuild = Effect.Effect<MainHarnessArtifactInput, HarnessBuildProblem>;

export type HarnessModuleMapBuilder = Readonly<{
  build(harnessCommit: HarnessCommit): HarnessBuild;
}>;

export type BuildWorkspace = Readonly<{
  runStep(step: HarnessBuildStep): Promise<CommandOutput>;
  readModuleMap(): Promise<string>;
}>;

export class WorkspaceModuleMapBuilder implements HarnessModuleMapBuilder {
  private readonly workspace: BuildWorkspace;
  private readonly configuration: HarnessBuildConfiguration;

  constructor(workspace: BuildWorkspace, configuration: HarnessBuildConfiguration) {
    this.workspace = workspace;
    this.configuration = configuration;
  }

  build(harnessCommit: HarnessCommit): HarnessBuild {
    const plan = planHarnessBuild(this.configuration, harnessCommit);

    const steps = Effect.forEach(plan.steps, (step) => this.runStep(step, harnessCommit), {
      discard: true,
    });

    return steps.pipe(Effect.andThen(this.readModuleMap(plan.moduleMapPath, harnessCommit)));
  }

  private runStep(
    step: HarnessBuildStep,
    harnessCommit: HarnessCommit,
  ): Effect.Effect<CommandOutput, HarnessBuildProblem> {
    const ran = Effect.tryPromise({
      try: () => this.workspace.runStep(step),
      catch: (error): HarnessBuildProblem => {
        logRedactedCause(
          `harness-build.${step.name}: ${isTimeoutFailure(error) ? "timeout" : "build-workspace-unavailable"}`,
          error,
        );

        return { code: "build-workspace-unavailable", harnessCommit };
      },
    });

    // The tail goes to the owner, not the log: command output can hold file contents.
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
          // `Response.json` decodes without asserting a type; `moduleMapFromBuildOutput` validates.
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

function lastUnits(text: string): string {
  const tail = text.slice(-DIAGNOSTIC_TAIL_LIMIT);
  const first = tail.codePointAt(0) ?? 0;

  const cut = text.length > DIAGNOSTIC_TAIL_LIMIT;

  return cut && first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
}

/** Redact before cutting: a cut could leave half a token. */
function stepDiagnostics(output: CommandOutput): BuildStepDiagnostics {
  const stdout = redactLogText(output.stdout);
  const stderr = redactLogText(output.stderr);

  return {
    stdoutTail: lastUnits(stdout),
    stderrTail: lastUnits(stderr),
    truncated: stdout.length > DIAGNOSTIC_TAIL_LIMIT || stderr.length > DIAGNOSTIC_TAIL_LIMIT,
  };
}
