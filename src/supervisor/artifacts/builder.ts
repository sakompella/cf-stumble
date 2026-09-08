import { Result } from "better-result";
import type { MainHarnessArtifactInput } from "../../facet/index.js";
import type { HarnessCommit } from "../../harness-commit.js";
import type { CommandOutput } from "../../workspace/index.js";
import {
  moduleMapFromBuildOutput,
  planHarnessBuild,
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
      const ran = await this.runStep(step, harnessCommit);
      if (ran.isErr()) {
        return Result.err(ran.error);
      }
    }

    return this.readModuleMap(plan.moduleMapPath, harnessCommit);
  }

  private async runStep(
    step: HarnessBuildStep,
    harnessCommit: HarnessCommit,
  ): Promise<Result<CommandOutput, HarnessBuildProblem>> {
    let output: CommandOutput;
    try {
      output = await this.workspace.runCommand(step.source, step.cwd);
    } catch {
      return Result.err({ code: "build-workspace-unavailable", harnessCommit });
    }

    if (output.exitCode !== 0) {
      // A build failure reaches the browser as a step name and an exit code, which says nothing
      // about what the command reported. The tail of the step's own output is the only account of
      // why the build failed, and it exists nowhere else once the build directory is cleared.
      console.error(`harness build step ${step.name} exited ${output.exitCode}`, {
        harnessCommit,
        stdout: output.stdout.slice(-2000),
        stderr: output.stderr.slice(-2000),
      });
      return Result.err({
        code: "build-step-failed",
        harnessCommit,
        step: step.name,
        exitCode: output.exitCode,
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
      console.error(`harness build wrote no module map at ${path}`, String(error));
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
