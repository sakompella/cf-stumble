// oxlint-disable max-lines, import/max-dependencies -- Connection reconciliation includes the size guard and clone failure mapping, and owns the GitHub, workspace, catalog, thread, and telemetry boundaries.

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { ConnectedProjects } from "./connected-projects.js";
import { ProjectLifecycleQueue } from "./project-lifecycle-queue.js";
import type { HarnessCommit } from "../../harness-commit.js";
import { PROJECT_CLONE_SIZE_FAILURE_EXIT_CODE } from "../../project-provision.js";
import {
  lookupRepositorySize,
  parseGitHubToken,
  repositorySizeReason,
  type GitHubFetch,
  type GitHubToken,
} from "../../github/index.js";
import type {
  GitHubConnection,
  GitHubConnectionEnvironment,
  GitHubConnectionStatus,
} from "./github-connection.js";
import {
  canonicalRepositoryUrl,
  parseProjectId,
  projectIdForRepository,
  resolveProject,
  type Project,
  type ProjectCatalog,
  type ProjectId,
  type PublicRepositoryUrl,
} from "../../project-catalog.js";
import { selectableCatalog, type SelectableCatalog } from "../../selectable-projects.js";
import {
  checkRepositoryAccess,
  clearWorkspaceProvision,
  provisionHarnessWorkspace,
  provisionProjectWorkspace,
  ProvisionStepFailed,
  type CredentialWorkspaceNamespace,
  type HarnessProvisionWorkspaceNamespace,
  type ProvisionWorkspaceNamespace,
  type ProjectRemovalWorkspaceNamespace,
} from "../../workspace/index.js";
import { logRedactedCause } from "../../diagnostics.js";
import { boundedRpc, WORKSPACE_RPC_TIMEOUT_MS } from "../../workspace-command-timeout.js";

function repositorySizeAllowed(
  repositoryUrl: PublicRepositoryUrl,
  token: GitHubToken | undefined,
  fetcher: GitHubFetch,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const lookup = yield* Effect.result(lookupRepositorySize(repositoryUrl, token, fetcher));

    const measured = Result.isSuccess(lookup) ? lookup.success : undefined;
    const reason = measured === undefined ? undefined : repositorySizeReason(measured);

    return reason === undefined || reason === "within-limits";
  });
}

export type DisconnectRepositoryResult =
  | Readonly<{ ok: true; projectId: ProjectId; workspace: "removed" | "failed" }>
  | Readonly<{
      ok: false;
      problem: Readonly<{
        code: "invalid-project-id" | "unknown-project-id" | "run-active" | "workspace-busy";
      }>;
    }>;

type ReleaseProject = (projectId: ProjectId) => boolean;

type ConnectRepositoryProblem = Readonly<{
  code:
    | "invalid-repository-url"
    | "project-id-conflict"
    | "repository-not-accessible"
    | "workspace-unavailable"
    | "tooling-missing"
    | "repository-too-large"
    | "provisioning-failed";
  detail: string;
}>;

export type ConnectRepositoryResult =
  | Readonly<{
      ok: true;
      project: Project;
      alreadyConnected: boolean;
      github: GitHubConnectionStatus;
      checkedAt: number | null;
    }>
  | Readonly<{
      ok: false;
      problem: ConnectRepositoryProblem;
      github: GitHubConnectionStatus;
      checkedAt: number | null;
    }>
  | Readonly<{ ok: false; problem: Readonly<{ code: "workspace-busy"; detail: "" }> }>;

type ProjectUseProblem = Readonly<{
  code:
    | "invalid-project-id"
    | "unknown-project-id"
    | "repository-too-large"
    | "provisioning-failed";
}>;

type ProjectUseResult =
  | Readonly<{ ok: true; project: Project }>
  | Readonly<{ ok: false; problem: ProjectUseProblem }>;

interface ProjectConnectionsInput {
  readonly storage: DurableObjectStorage;
  readonly workspaceName: string;
  readonly namespace: CredentialWorkspaceNamespace &
    ProvisionWorkspaceNamespace &
    HarnessProvisionWorkspaceNamespace &
    ProjectRemovalWorkspaceNamespace;
  readonly environment: Pick<GitHubConnectionEnvironment, "fallbackToken" | "fetcher">;
  readonly github: GitHubConnection;
}

export class ProjectConnections {
  private readonly projects: ConnectedProjects;
  private readonly lifecycle = new ProjectLifecycleQueue();
  private readonly github: GitHubConnection;
  private readonly workspaceName: string;
  private readonly namespace: CredentialWorkspaceNamespace &
    ProvisionWorkspaceNamespace &
    HarnessProvisionWorkspaceNamespace &
    ProjectRemovalWorkspaceNamespace;
  private readonly repositorySizeToken: GitHubToken | undefined;
  private readonly githubFetcher: GitHubFetch;

  constructor(input: ProjectConnectionsInput) {
    this.projects = new ConnectedProjects(input.storage);
    this.workspaceName = input.workspaceName;
    this.namespace = input.namespace;
    this.repositorySizeToken = parseGitHubToken(input.environment.fallbackToken);
    this.githubFetcher = input.environment.fetcher;
    this.github = input.github;
  }

  catalog(): SelectableCatalog {
    return selectableCatalog(this.projects.catalog());
  }

  // oxlint-disable-next-line max-lines-per-function -- The workflow keeps guard, credential, access, and catalog effects ordered.
  connect(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the repository URL arrives from a client.
    repositoryUrl: unknown,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the display name arrives from a client.
    displayName: unknown,
    now: number,
  ): Effect.Effect<ConnectRepositoryResult> {
    return Effect.gen({ self: this }, function* () {
      const canonical = canonicalRepositoryUrl(repositoryUrl);
      const projectId = canonical === undefined ? undefined : projectIdForRepository(canonical);

      if (canonical === undefined || projectId === undefined) {
        return this.refused(
          { code: "invalid-repository-url", detail: "" },
          { state: "disconnected" },
        );
      }

      const sizeAllowed = yield* repositorySizeAllowed(
        canonical,
        this.repositorySizeToken,
        this.githubFetcher,
      );

      if (!sizeAllowed) {
        return this.refused(
          { code: "repository-too-large", detail: "" },
          { state: "disconnected" },
        );
      }

      const github = yield* this.github.ensureCredential(now);

      if (github.state === "tooling-missing") {
        return this.refused({ code: "tooling-missing", detail: "" }, github);
      }

      const access = yield* Effect.result(
        checkRepositoryAccess({
          workspaceName: this.workspaceName,
          namespace: this.namespace,
          repositoryUrl: canonical,
        }),
      );

      if (Result.isFailure(access)) {
        return this.refused(
          { code: "workspace-unavailable", detail: access.failure.detail },
          github,
        );
      }

      if (!access.success.granted) {
        return this.refused(
          { code: "repository-not-accessible", detail: access.success.detail },
          github,
        );
      }

      return yield* this.lifecycle.exclusive(
        projectId,
        this.store(canonical, displayName, github, now),
      );
    });
  }

  disconnect(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The Supervisor resolves this client id before calling the workspace.
    projectId: unknown,
    release: ReleaseProject,
  ): Effect.Effect<DisconnectRepositoryResult> {
    const parsed = parseProjectId(projectId);

    if (parsed === undefined) {
      return Effect.succeed({ ok: false, problem: { code: "invalid-project-id" } });
    }

    return this.lifecycle.exclusive(
      parsed,
      Effect.gen({ self: this }, function* () {
        const resolved = resolveProject(parsed, this.projects.catalog());

        if (!resolved.ok) {
          return { ok: false, problem: { code: resolved.reason } } as const;
        }

        if (!release(resolved.project.id)) {
          return { ok: false, problem: { code: "run-active" } } as const;
        }

        this.projects.disconnect(resolved.project.id);
        const workspace = yield* this.removeProjectDirectories(resolved.project.id);

        return { ok: true, projectId: resolved.project.id, workspace } as const;
      }),
    );
  }

  resetWorkspace(): void {
    clearWorkspaceProvision(this.workspaceName);
    this.github.resetWorkspace();
  }

  ensureHarnessProvisioned(
    harnessCommit: HarnessCommit,
    signal?: AbortSignal,
  ): Effect.Effect<boolean> {
    return provisionHarnessWorkspace({
      workspaceName: this.workspaceName,
      harnessCommit,
      namespace: this.namespace,
      signal,
    }).pipe(
      Effect.match({
        onFailure: () => false,
        onSuccess: () => true,
      }),
    );
  }

  ensureProvisioned(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the project id arrives from a client.
    projectId: unknown,
    signal?: AbortSignal,
  ): Effect.Effect<ProjectUseResult> {
    const parsed = parseProjectId(projectId);

    if (parsed === undefined) {
      return Effect.succeed({ ok: false, problem: { code: "invalid-project-id" } });
    }

    return this.lifecycle.exclusive(parsed, this.provisionConnected(parsed, signal));
  }

  private provisionConnected(
    projectId: ProjectId,
    signal?: AbortSignal,
  ): Effect.Effect<ProjectUseResult> {
    return Effect.gen({ self: this }, function* () {
      const catalog: ProjectCatalog = this.projects.catalog();
      const resolved = resolveProject(projectId, catalog);

      if (!resolved.ok) {
        return { ok: false, problem: { code: resolved.reason } } as const;
      }

      const provision = provisionProjectWorkspace({
        workspaceName: this.workspaceName,
        projectId: resolved.project.id,
        catalog,
        namespace: this.namespace,
        signal,
      });

      let provisioned = yield* Effect.result(provision);

      const credentialWasWorking = this.github.lastKnown(Date.now()).github?.state === "connected";

      if (
        !credentialWasWorking &&
        Result.isFailure(provisioned) &&
        provisioned.failure instanceof ProvisionStepFailed &&
        provisioned.failure.exitCode !== PROJECT_CLONE_SIZE_FAILURE_EXIT_CODE
      ) {
        const github = yield* this.github.ensureCredential(Date.now(), signal);

        if (github.state === "connected" && signal?.aborted !== true) {
          provisioned = yield* Effect.result(provision);
        }
      }

      if (Result.isFailure(provisioned)) {
        const diskFailure =
          provisioned.failure instanceof ProvisionStepFailed &&
          provisioned.failure.exitCode === PROJECT_CLONE_SIZE_FAILURE_EXIT_CODE;

        return {
          ok: false,
          problem: { code: diskFailure ? "repository-too-large" : "provisioning-failed" },
        } as const;
      }

      return { ok: true, project: resolved.project } as const;
    });
  }

  private store(
    repositoryUrl: PublicRepositoryUrl,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: see `connect`.
    displayName: unknown,
    github: GitHubConnectionStatus,
    now: number,
  ): Effect.Effect<ConnectRepositoryResult> {
    return Effect.gen({ self: this }, function* () {
      const connected = this.projects.connect({ repositoryUrl, displayName }, now);

      if (!connected.ok) {
        return this.refused({ code: connected.problem.code, detail: "" }, github);
      }

      const provisioned = yield* this.provisionConnected(connected.project.id);

      if (!provisioned.ok) {
        if (!connected.alreadyConnected) {
          this.projects.disconnect(connected.project.id);
        }

        return this.refused(
          {
            code:
              provisioned.problem.code === "repository-too-large"
                ? "repository-too-large"
                : "provisioning-failed",
            detail: "",
          },
          github,
        );
      }

      return {
        ok: true,
        project: connected.project,
        alreadyConnected: connected.alreadyConnected,
        github,
        checkedAt: this.github.checkedAt(),
      } as const;
    });
  }

  private removeProjectDirectories(projectId: ProjectId): Effect.Effect<"removed" | "failed"> {
    const removalNamespace: ProjectRemovalWorkspaceNamespace = this.namespace;

    return Effect.promise(() =>
      boundedRpc(
        () =>
          removalNamespace.getByName(this.workspaceName).removeProject({
            kind: "remove-project",
            projectId,
          }),
        WORKSPACE_RPC_TIMEOUT_MS,
      ).then(
        (result) =>
          result.ok && result.result.kind === "command" && result.result.exitCode === 0
            ? "removed"
            : "failed",
        (cause: unknown) => {
          logRedactedCause(`project-disconnect.${projectId}: workspace-unavailable`, cause);

          return "failed";
        },
      ),
    );
  }

  private refused(
    problem: ConnectRepositoryProblem,
    github: GitHubConnectionStatus,
  ): ConnectRepositoryResult {
    return { ok: false, problem, github, checkedAt: this.github.checkedAt() };
  }
}
