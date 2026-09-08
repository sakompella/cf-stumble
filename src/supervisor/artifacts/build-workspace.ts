import type { HarnessCommit } from "../../harness-commit.js";
import { HARNESS_BUILD_CONFIGURATION, planHarnessBuild } from "../../harness-build.js";
import type {
  HarnessBuildConfiguration,
  HarnessBuildPlan,
  HarnessBuildRequest,
} from "../../harness-build.js";
import type { CommandOutput, WorkspaceResult } from "../../workspace/index.js";
import { WorkspaceModuleMapBuilder } from "./builder.js";
import type { BuildWorkspace, HarnessBuildResult, HarnessModuleMapBuilder } from "./builder.js";

/** The Workspace Host build surface as the Supervisor uses it: a commit and a planned step. */
export type BuildWorkspaceHost = Readonly<{
  build(request: HarnessBuildRequest): Promise<WorkspaceResult>;
}>;

/**
 * Just enough of the Workspace Host binding to reach one workspace by name. The Supervisor builds
 * in the tenant's own workspace and names it from its own server-derived tenant key, so no request
 * can point a build at another workspace and no build shares a container with another tenant.
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
    if (result.result.kind !== "command") {
      throw unreachable(`the build output returned ${result.result.kind}, not a command`);
    }
    if (result.result.exitCode !== 0) {
      // A build that wrote no module map, or wrote it through a symbolic link, is an ordinary
      // build failure rather than an impossible state, so this throws for the builder to report
      // as `build-output-missing`.
      throw new Error(`the build wrote no readable module map: exit ${result.result.exitCode}`);
    }

    return result.result.stdout;
  }
}

/**
 * The builder the Supervisor uses for a cache miss. Every build gets a workspace bound to its own
 * commit, so two builds cannot confuse each other's steps, and every failure stays a plain typed
 * `HarnessBuildProblem` that leaves the active generation serving.
 *
 * One build per commit at a time. The build plan extracts a commit into a scratch directory named
 * after that commit and clears it first, so a second build of the same commit would delete the
 * files the first is compiling. A request for a commit already building therefore joins the build
 * in flight and receives its result, and the entry is dropped as soon as that build settles, so a
 * later request for the same commit builds again. This is a conflict rule, not a queue: nothing is
 * deferred, ordered, or retried here, and builds of different commits do not wait for each other.
 *
 * Two tenants cannot collide at all, because the workspace name is the tenant's own and each
 * tenant's scratch subtree lives in that tenant's container.
 */
export class WorkspaceHostModuleMapBuilder implements HarnessModuleMapBuilder {
  private readonly namespace: BuildWorkspaceNamespace;
  private readonly workspaceName: string;
  private readonly configuration: HarnessBuildConfiguration;
  private readonly inFlight = new Map<HarnessCommit, Promise<HarnessBuildResult>>();

  constructor(
    namespace: BuildWorkspaceNamespace,
    workspaceName: string,
    configuration: HarnessBuildConfiguration = HARNESS_BUILD_CONFIGURATION,
  ) {
    this.namespace = namespace;
    this.workspaceName = workspaceName;
    this.configuration = configuration;
  }

  build(harnessCommit: HarnessCommit): Promise<HarnessBuildResult> {
    const building = this.inFlight.get(harnessCommit);
    if (building !== undefined) {
      return building;
    }

    const started = this.runBuild(harnessCommit).finally(() => {
      this.inFlight.delete(harnessCommit);
    });
    this.inFlight.set(harnessCommit, started);
    return started;
  }

  private runBuild(harnessCommit: HarnessCommit): Promise<HarnessBuildResult> {
    // The name is the tenant's own, never request data.
    const host = this.namespace.getByName(this.workspaceName);
    const workspace = new CommitBuildWorkspace(host, this.configuration, harnessCommit);
    return new WorkspaceModuleMapBuilder(workspace, this.configuration).build(harnessCommit);
  }
}
