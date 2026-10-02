import { Result } from "better-result";
import type { MainHarnessArtifactInput } from "../../facet/index.js";
import type { HarnessCommit } from "../../harness-commit.js";
import type { CommandOutput } from "../../workspace/index.js";
import {
  isTimeoutFailure,
  logCommit,
  logRedactedCause,
  redactLogText,
  timed,
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

export type HarnessBuildResult = Result<MainHarnessArtifactInput, HarnessBuildProblem>;

/** How the resolver asks for a module map it does not have. */
export type HarnessModuleMapBuilder = Readonly<{
  build(harnessCommit: HarnessCommit): Promise<HarnessBuildResult>;
}>;

/**
 * The only operations a build needs from its workspace. It stays narrower than the operations the
 * project capability offers: a build runs commands and reads its own output, nothing else.
 */
export type BuildWorkspace = Readonly<{
  runCommand(source: string, cwd: string): Promise<CommandOutput>;
  readFile(path: string): Promise<string>;
}>;

/** Builds a labeled harness commit in the scratch subtree kept apart from every repository. */
export class WorkspaceModuleMapBuilder implements HarnessModuleMapBuilder {
  private readonly workspace: BuildWorkspace;
  private readonly configuration: HarnessBuildConfiguration;

  constructor(workspace: BuildWorkspace, configuration: HarnessBuildConfiguration) {
    this.workspace = workspace;
    this.configuration = configuration;
  }

  async build(harnessCommit: HarnessCommit): Promise<HarnessBuildResult> {
    const plan = planHarnessBuild(this.configuration, harnessCommit);

    for (const step of plan.steps) {
      const ran = await timed(
        "harness-build.step",
        { commit: logCommit(harnessCommit), step: step.name },
        () => this.runStep(step, harnessCommit),
        buildOutcome,
      );

      if (ran.isErr()) {
        return Result.err(ran.error);
      }
    }

    return timed(
      "harness-build.output",
      { commit: logCommit(harnessCommit) },
      () => this.readModuleMap(plan.moduleMapPath, harnessCommit),
      buildOutcome,
    );
  }

  private async runStep(
    step: HarnessBuildStep,
    harnessCommit: HarnessCommit,
  ): Promise<Result<CommandOutput, HarnessBuildProblem>> {
    let output: CommandOutput;

    try {
      output = await this.workspace.runCommand(step.source, step.cwd);
    } catch (error) {
      // `build-workspace-unavailable` says nothing about which of the workspace, the container or
      // the connection to them gave way, and each of those failed at least once during this
      // project's deployed builds.
      logRedactedCause(
        `harness-build.${step.name}: ${isTimeoutFailure(error) ? "timeout" : "build-workspace-unavailable"}`,
        error,
      );

      return Result.err({ code: "build-workspace-unavailable", harnessCommit });
    }

    if (output.exitCode !== 0) {
      // The tail of the step's own output is the only account of why the build failed, and it
      // exists nowhere else once the build directory is cleared. It goes to the owner in the
      // submission response and is not logged: command output can hold file contents. The log
      // keeps the step, the exit code, and the duration (`buildOutcome`).
      return Result.err({
        code: "build-step-failed",
        harnessCommit,
        step: step.name,
        exitCode: output.exitCode,
        diagnostics: stepDiagnostics(output),
      });
    }

    return Result.ok(output);
  }

  private async readModuleMap(
    path: string,
    harnessCommit: HarnessCommit,
  ): Promise<HarnessBuildResult> {
    let encoded: string;

    try {
      encoded = await this.workspace.readFile(path);
    } catch (error) {
      logRedactedCause(`harness-build.output ${path}: build-output-missing`, error);

      return Result.err({ code: "build-output-missing", harnessCommit });
    }

    let decoded: BuiltModuleMapFile;

    try {
      // `Response.json` decodes without asserting a type the build has not proved yet;
      // `moduleMapFromBuildOutput` validates the decoded value.
      decoded = await new Response(encoded).json<BuiltModuleMapFile>();
    } catch {
      return Result.err({
        code: "build-output-invalid",
        harnessCommit,
        reason: "invalid-artifact",
      });
    }

    return moduleMapFromBuildOutput(harnessCommit, decoded);
  }
}

const DIAGNOSTIC_TAIL_LIMIT = 2_000;

/** The redacted tail of each stream. Redaction runs first: a cut could leave half a token. */
function stepDiagnostics(output: CommandOutput): BuildStepDiagnostics {
  const stdout = redactLogText(output.stdout);
  const stderr = redactLogText(output.stderr);

  return {
    stdoutTail: stdout.slice(-DIAGNOSTIC_TAIL_LIMIT),
    stderrTail: stderr.slice(-DIAGNOSTIC_TAIL_LIMIT),
    truncated: stdout.length > DIAGNOSTIC_TAIL_LIMIT || stderr.length > DIAGNOSTIC_TAIL_LIMIT,
  };
}

/** A build step's log outcome: `ok`, or the problem code and, for a failed command, its exit code. */
function buildOutcome<Value>(ran: Result<Value, HarnessBuildProblem>): TimedOutcome {
  if (ran.isOk()) return { outcome: "ok" };

  return {
    outcome: ran.error.code,
    level: "warn",
    fields: ran.error.code === "build-step-failed" ? { exitCode: ran.error.exitCode } : {},
  };
}

/**
 * The builder for a Supervisor with no build workspace. The Supervisor now wires
 * `WorkspaceHostModuleMapBuilder` instead, so this remains for a caller that must resolve without
 * building: a cache miss then reports a plain typed failure, which leaves the active generation
 * serving instead of pretending to build.
 */
export const absentModuleMapBuilder: HarnessModuleMapBuilder = {
  build(harnessCommit: HarnessCommit): Promise<HarnessBuildResult> {
    return Promise.resolve(Result.err({ code: "build-workspace-unavailable", harnessCommit }));
  },
};
