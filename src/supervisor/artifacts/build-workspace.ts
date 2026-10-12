import * as Effect from "effect/Effect";
import type * as Result from "effect/Result";
import type { HarnessCommit } from "../../harness-commit.js";
import { runAtEntryPoint } from "../../run-entry-point.js";
import { classifyWorkspaceAnswer, timedWorkspaceRpc } from "../../diagnostics.js";
import { WORKSPACE_RPC_TIMEOUT_MS } from "../../workspace-command-timeout.js";
import { HARNESS_BUILD_CONFIGURATION } from "../../harness-build.js";
import type {
  HarnessBuildConfiguration,
  HarnessBuildRequest,
  HarnessBuildStep,
} from "../../harness-build.js";
import type { CommandOutput, WorkspaceResult } from "../../workspace/index.js";
import { WorkspaceModuleMapBuilder } from "./builder.js";
import type { BuildWorkspace, HarnessBuild, HarnessModuleMapBuilder } from "./builder.js";

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

/**
 * The `BuildWorkspace` the builder runs against, bound to one harness commit. It sends the
 * Workspace Host a step's name, never its command text: the Host plans the same commit itself and
 * runs only the step of that name.
 */
class CommitBuildWorkspace implements BuildWorkspace {
  /**
   * A fresh stub for every call, not one stub for the whole build.
   *
   * A build is minutes long and its steps are separate calls. The Workspace Host can restart
   * meanwhile ("this Durable Object instance is no longer active"), and a stub taken before the
   * build would die with it. A stub is cheap, so each call takes its own.
   */
  private readonly host: () => BuildWorkspaceHost;
  private readonly harnessCommit: HarnessCommit;

  constructor(host: () => BuildWorkspaceHost, harnessCommit: HarnessCommit) {
    this.host = host;
    this.harnessCommit = harnessCommit;
  }

  async runStep(step: HarnessBuildStep): Promise<CommandOutput> {
    const result = await timedWorkspaceRpc(
      { method: "build", step: step.name },
      () =>
        this.host().build({
          kind: "build-step",
          harnessCommit: this.harnessCommit,
          step: step.name,
        }),
      classifyWorkspaceAnswer,
      WORKSPACE_RPC_TIMEOUT_MS,
    );

    if (!result.ok) {
      throw new Error(`the build workspace refused the ${step.name} step: ${result.error.code}`);
    }

    if (result.result.kind !== "command") {
      throw new Error(`the ${step.name} step returned ${result.result.kind}, not a command`);
    }

    return {
      stdout: result.result.stdout,
      stderr: result.result.stderr,
      exitCode: result.result.exitCode,
    };
  }

  async readModuleMap(): Promise<string> {
    const result = await timedWorkspaceRpc(
      { method: "build", step: "output" },
      () =>
        this.host().build({
          kind: "build-output",
          harnessCommit: this.harnessCommit,
        }),
      classifyWorkspaceAnswer,
      WORKSPACE_RPC_TIMEOUT_MS,
    );

    if (!result.ok) {
      throw new Error(`the build output could not be read: ${result.error.code}`);
    }

    if (result.result.kind !== "command") {
      throw new Error(`the build output returned ${result.result.kind}, not a command`);
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
 * Their provision steps still share the harness checkout, so the provision shell takes its own
 * lock in the workspace container (`provisionHarnessRepository`) rather than relying on this map.
 *
 * Two tenants cannot collide at all, because the workspace name is the tenant's own and each
 * tenant's scratch subtree lives in that tenant's container.
 *
 * A build in flight is a native Promise of its settled result, run as its own program. It belongs
 * to every caller that joined it, so no one caller's fiber runs it, and a caller that stops
 * waiting does not stop it or drop it from the map before it settles.
 */
export class WorkspaceHostModuleMapBuilder implements HarnessModuleMapBuilder {
  private readonly namespace: BuildWorkspaceNamespace;
  private readonly workspaceName: string;
  private readonly configuration: HarnessBuildConfiguration;
  private readonly inFlight = new Map<HarnessCommit, Promise<SettledBuild>>();

  constructor(
    namespace: BuildWorkspaceNamespace,
    workspaceName: string,
    configuration: HarnessBuildConfiguration = HARNESS_BUILD_CONFIGURATION,
  ) {
    this.namespace = namespace;
    this.workspaceName = workspaceName;
    this.configuration = configuration;
  }

  build(harnessCommit: HarnessCommit): HarnessBuild {
    return Effect.suspend(() => {
      const settled = this.inFlight.get(harnessCommit) ?? this.start(harnessCommit);

      return Effect.promise(() => settled).pipe(
        Effect.flatMap((result) => Effect.fromResult(result)),
      );
    });
  }

  private start(harnessCommit: HarnessCommit): Promise<SettledBuild> {
    const started = runAtEntryPoint(Effect.result(this.runBuild(harnessCommit))).finally(() => {
      this.inFlight.delete(harnessCommit);
    });

    this.inFlight.set(harnessCommit, started);

    return started;
  }

  private runBuild(harnessCommit: HarnessCommit): HarnessBuild {
    // The name is the tenant's own, never request data.
    const workspace = new CommitBuildWorkspace(
      () => this.namespace.getByName(this.workspaceName),
      harnessCommit,
    );

    return new WorkspaceModuleMapBuilder(workspace, this.configuration).build(harnessCommit);
  }
}

/** A build that has finished, with its outcome as a value, so every caller that joined it reads it. */
type SettledBuild = Result.Result<Effect.Success<HarnessBuild>, Effect.Error<HarnessBuild>>;
