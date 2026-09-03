import type { HarnessCommit } from "../../harness-commit.js";
import { HARNESS_BUILD_CONFIGURATION, planHarnessBuild } from "../../harness-build.js";
import type {
  HarnessBuildConfiguration,
  HarnessBuildPlan,
  HarnessBuildRequest,
} from "../../harness-build.js";
import { HARNESS_BUILD_WORKSPACE_NAME } from "../../workspace-names.js";
import type { CommandOutput, WorkspaceResult } from "../../workspace/index.js";
import { WorkspaceModuleMapBuilder } from "./builder.js";
import type { BuildWorkspace, HarnessBuildResult, HarnessModuleMapBuilder } from "./builder.js";

/** The Workspace Host build surface as the Supervisor uses it: a commit and a planned step. */
export type BuildWorkspaceHost = Readonly<{
  build(request: HarnessBuildRequest): Promise<WorkspaceResult>;
}>;

/**
 * Just enough of the Workspace Host binding to reach one workspace by name. The Supervisor names
 * its build workspace from a module constant, so no request can point a build at another
 * workspace.
 */
export type BuildWorkspaceNamespace = Readonly<{
  getByName(name: string): BuildWorkspaceHost;
}>;

function unreachable(reason: string): Error {
  return new Error(reason);
}

/**
 * The `BuildWorkspace` the builder runs against, bound to one harness commit. It plans that
 * commit itself, so it can name the planned step the Workspace Host should run instead of sending
 * command text, and it refuses any command or path that is not part of that commit's build.
 */
export class CommitBuildWorkspace implements BuildWorkspace {
  private readonly host: BuildWorkspaceHost;
  private readonly harnessCommit: HarnessCommit;
  private readonly plan: HarnessBuildPlan;

  constructor(
    host: BuildWorkspaceHost,
    configuration: HarnessBuildConfiguration,
    harnessCommit: HarnessCommit,
  ) {
    this.host = host;
    this.harnessCommit = harnessCommit;
    this.plan = planHarnessBuild(configuration, harnessCommit);
  }

  async runCommand(source: string, cwd: string): Promise<CommandOutput> {
    const step = this.plan.steps.find(
      (planned) => planned.source === source && planned.cwd === cwd,
    );
    if (step === undefined) {
      throw unreachable("a build workspace runs only the planned steps of its own commit");
    }

    const result = await this.host.build({
      kind: "build-step",
      harnessCommit: this.harnessCommit,
      step: step.name,
    });
    if (!result.ok) {
      throw unreachable(`the build workspace refused the ${step.name} step: ${result.error.code}`);
    }
    if (result.result.kind !== "command") {
      throw unreachable(`the ${step.name} step returned ${result.result.kind}, not a command`);
    }

    return {
      stdout: result.result.stdout,
      stderr: result.result.stderr,
      exitCode: result.result.exitCode,
    };
  }

  async readFile(path: string): Promise<string> {
    if (path !== this.plan.moduleMapPath) {
      throw unreachable("a build workspace reads only its own module map");
    }

    const result = await this.host.build({
      kind: "build-output",
      harnessCommit: this.harnessCommit,
    });
    if (!result.ok) {
      throw unreachable(`the build output could not be read: ${result.error.code}`);
    }
    if (result.result.kind !== "file") {
      throw unreachable(`the build output returned ${result.result.kind}, not a file`);
    }

    return result.result.content;
  }
}

/**
 * The builder the Supervisor uses for a cache miss. Every build gets a workspace bound to its own
 * commit, so two builds cannot confuse each other's steps, and every failure stays a plain typed
 * `HarnessBuildProblem` that leaves the active generation serving.
 */
export class WorkspaceHostModuleMapBuilder implements HarnessModuleMapBuilder {
  private readonly namespace: BuildWorkspaceNamespace;
  private readonly configuration: HarnessBuildConfiguration;

  constructor(
    namespace: BuildWorkspaceNamespace,
    configuration: HarnessBuildConfiguration = HARNESS_BUILD_CONFIGURATION,
  ) {
    this.namespace = namespace;
    this.configuration = configuration;
  }

  build(harnessCommit: HarnessCommit): Promise<HarnessBuildResult> {
    // The name is a module constant, never request data, and never the project workspace name.
    const host = this.namespace.getByName(HARNESS_BUILD_WORKSPACE_NAME);
    const workspace = new CommitBuildWorkspace(host, this.configuration, harnessCommit);
    return new WorkspaceModuleMapBuilder(workspace, this.configuration).build(harnessCommit);
  }
}
