import * as Effect from "effect/Effect";
import type * as Result from "effect/Result";
import type { HarnessCommit } from "../../harness-commit.js";
import { runAtEntryPoint } from "../../run-entry-point.js";
import { boundedRpc, WORKSPACE_RPC_TIMEOUT_MS } from "../../workspace-command-timeout.js";
import { HARNESS_BUILD_CONFIGURATION } from "../../harness-build.js";
import type {
  HarnessBuildConfiguration,
  HarnessBuildRequest,
  HarnessBuildStep,
} from "../../harness-build.js";
import type { CommandOutput, WorkspaceResult } from "../../workspace/index.js";
import { WorkspaceModuleMapBuilder } from "./builder.js";
import type { BuildWorkspace, HarnessBuild, HarnessModuleMapBuilder } from "./builder.js";

export type BuildWorkspaceHost = Readonly<{
  build(request: HarnessBuildRequest): Promise<WorkspaceResult>;
}>;

export type BuildWorkspaceNamespace = Readonly<{
  getByName(name: string): BuildWorkspaceHost;
}>;

class CommitBuildWorkspace implements BuildWorkspace {
  private readonly host: () => BuildWorkspaceHost;
  private readonly harnessCommit: HarnessCommit;

  constructor(host: () => BuildWorkspaceHost, harnessCommit: HarnessCommit) {
    this.host = host;
    this.harnessCommit = harnessCommit;
  }

  async runStep(step: HarnessBuildStep): Promise<CommandOutput> {
    const result = await boundedRpc(
      () =>
        this.host().build({
          kind: "build-step",
          harnessCommit: this.harnessCommit,
          step: step.name,
        }),
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
    const result = await boundedRpc(
      () =>
        this.host().build({
          kind: "build-output",
          harnessCommit: this.harnessCommit,
        }),
      WORKSPACE_RPC_TIMEOUT_MS,
    );

    if (!result.ok) {
      throw new Error(`the build output could not be read: ${result.error.code}`);
    }

    if (result.result.kind !== "command") {
      throw new Error(`the build output returned ${result.result.kind}, not a command`);
    }

    if (result.result.exitCode !== 0) {
      throw new Error(`the build wrote no readable module map: exit ${result.result.exitCode}`);
    }

    return result.result.stdout;
  }
}

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
    const workspace = new CommitBuildWorkspace(
      () => this.namespace.getByName(this.workspaceName),
      harnessCommit,
    );

    return new WorkspaceModuleMapBuilder(workspace, this.configuration).build(harnessCommit);
  }
}

type SettledBuild = Result.Result<Effect.Success<HarnessBuild>, Effect.Error<HarnessBuild>>;
