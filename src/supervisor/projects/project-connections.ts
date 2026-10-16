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
import { logEvent, logRedactedCause, timedWorkspaceRpc } from "../../diagnostics.js";
import { WORKSPACE_RPC_TIMEOUT_MS } from "../../workspace-command-timeout.js";
import type { DisconnectProjectResult } from "../threads/index.js";

function repositorySizeAllowed(
  project: ProjectId,
  repositoryUrl: PublicRepositoryUrl,
  token: GitHubToken | undefined,
  fetcher: GitHubFetch,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const lookup = yield* Effect.result(lookupRepositorySize(repositoryUrl, token, fetcher));

    const measured = Result.isSuccess(lookup) ? lookup.success : undefined;
    const reason = measured === undefined ? undefined : repositorySizeReason(measured);

    const outcome =
      measured === undefined ? "skipped" : reason === "within-limits" ? "allowed" : "refused";

    logEvent(outcome === "allowed" ? "info" : "warn", "project.size-check", {
      project,
      sizeKb: measured?.sizeKb ?? null,
      blobCount: measured?.blobCount ?? null,
      blobBytes: measured?.blobBytes ?? null,
      truncated: measured?.truncated ?? null,
      outcome,
      reason: reason ?? "lookup-failed",
    });

    return reason === undefined || reason === "within-limits";
  });
}

/** `workspace-busy`: an owner reset was running, so nothing was disconnected. */
export type DisconnectRepositoryResult =
  | Readonly<{ ok: true; projectId: ProjectId; workspace: "removed" | "failed" }>
  | Extract<DisconnectProjectResult, { ok: false }>
  | Readonly<{ ok: false; problem: Readonly<{ code: "workspace-busy" }> }>;

/**
 * Removes the project's thread, or refuses because a turn still owns it. It runs inside the
 * disconnect's ordered operation, so no turn can be admitted between it and the row removal.
 */
type ReleaseProjectThread = () => DisconnectProjectResult;

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

/**
 * A refused connect carries the GitHub status it saw, except one refused `workspace-busy` because
 * an owner reset was running: that one asked nothing of the workspace.
 */
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

/** Why a project could not be provisioned when it was used. */
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
  /** The tenant's one workspace, named server-side. See `workspace-names.ts`. */
  readonly workspaceName: string;
  readonly namespace: CredentialWorkspaceNamespace &
    ProvisionWorkspaceNamespace &
    HarnessProvisionWorkspaceNamespace &
    ProjectRemovalWorkspaceNamespace;
  /** The size check asks GitHub for repository metadata with the connection's token and fetcher. */
  readonly environment: Pick<GitHubConnectionEnvironment, "fallbackToken" | "fetcher">;
  /** The tenant's one GitHub connection. The Supervisor builds it and serves its authorization. */
  readonly github: GitHubConnection;
}

/**
 * Connecting repositories to one tenant: the catalog, the GitHub authorization behind it, and the
 * provisioning that makes a connected repository usable.
 *
 * The Supervisor holds one of these and delegates to it, so the RPC class stays a surface and the
 * order of the steps lives here. That order is the point of the module. Access proves who the
 * owner is and grants no repository access (ADR-0039); the workspace's own credential is what
 * reaches GitHub; a repository is checked before it becomes a project; and a project is stored
 * only once its clone is in the workspace, so a project in the list is a project with files.
 */
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

  /**
   * Everything this tenant may select: the connected repositories and the harness entry.
   *
   * It is read on each call rather than cached, because connecting a repository has to be visible
   * to the next request without restarting anything. The harness entry is added here, in the one
   * place the catalog is built, so the sidebar, the thread surface and the turn path all see the
   * same set and none of them has to remember a special case.
   */
  catalog(): SelectableCatalog {
    return selectableCatalog(this.projects.catalog());
  }

  /**
   * Connect one repository to this tenant.
   *
   * The credential is made usable first, because a private repository is unreachable without one
   * and the `GH_TOKEN` fallback exists exactly so an unattended run can get that far. The access
   * check then runs through the workspace's own Git, so what is verified is what a clone will do
   * rather than what cf-stumble believes. Only then is the project stored and provisioned, and a
   * clone that fails takes a newly stored project back out: a project in the list has files.
   */
  // oxlint-disable-next-line max-lines-per-function -- The workflow keeps guard, credential, access, and catalog effects ordered.
  connect(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the repository URL arrives from a client.
    repositoryUrl: unknown,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the display name arrives from a client.
    displayName: unknown,
    now: number,
  ): Effect.Effect<ConnectRepositoryResult> {
    // oxlint-disable-next-line max-lines-per-function -- The same workflow, as the generator that runs it.
    return Effect.gen({ self: this }, function* () {
      const canonical = canonicalRepositoryUrl(repositoryUrl);
      const projectId = canonical === undefined ? undefined : projectIdForRepository(canonical);

      // A URL that derives no project id could never be stored, so it is refused before the
      // workspace is asked to reach it.
      if (canonical === undefined || projectId === undefined) {
        return this.refused(
          { code: "invalid-repository-url", detail: "" },
          { state: "disconnected" },
        );
      }

      const sizeAllowed = yield* repositorySizeAllowed(
        projectId,
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

      // The check fails only when the workspace could not be asked; a refusal is a granted: false.
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

  /**
   * Release a connected project's thread, remove its catalog row, then best-effort remove its
   * durable workspace directories. The whole sequence is one ordered operation for the project id,
   * so a reconnect cannot clone into the directory while this removal is still running.
   */
  disconnect(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The Supervisor resolves this client id before calling the workspace.
    projectId: unknown,
    releaseThread: ReleaseProjectThread,
  ): Effect.Effect<DisconnectRepositoryResult> {
    const parsed = parseProjectId(projectId);

    if (parsed === undefined) {
      return Effect.succeed({ ok: false, problem: { code: "invalid-project-id" } });
    }

    return this.lifecycle.exclusive(
      parsed,
      Effect.gen({ self: this }, function* () {
        const thread = releaseThread();

        if (!thread.ok) return thread;

        const resolved = resolveProject(parsed, this.projects.catalog());

        if (!resolved.ok) {
          return { ok: false, problem: { code: resolved.reason } } as const;
        }

        this.projects.disconnect(resolved.project.id);
        const workspace = yield* this.removeProjectDirectories(resolved.project.id);

        logEvent(workspace === "removed" ? "info" : "error", "project.disconnected", {
          project: resolved.project.id,
          workspace,
        });

        return { ok: true, projectId: resolved.project.id, workspace } as const;
      }),
    );
  }

  /** Forget workspace-owned transient state after the owner resets the workspace. */
  resetWorkspace(): void {
    clearWorkspaceProvision(this.workspaceName);
    this.github.resetWorkspace();
  }

  /** Reconcile the editable harness checkout before a harness turn starts. */
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

  /**
   * Provision a project because it is about to be used. Every run performs every step, so this is
   * also what repairs a workspace the platform recreated: the state that matters is in the
   * workspace, and nothing here remembers having provisioned before.
   */
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

  /** The body of `ensureProvisioned`, for a caller already running in the project's queue. */
  private provisionConnected(
    projectId: ProjectId,
    signal?: AbortSignal,
  ): Effect.Effect<ProjectUseResult> {
    return Effect.gen({ self: this }, function* () {
      // Only connected repositories reach this path: harness turns use the generation-bound
      // reconciler above because the harness entry has no catalog repository URL.
      const catalog: ProjectCatalog = this.projects.catalog();
      const resolved = resolveProject(projectId, catalog);

      if (!resolved.ok) {
        return { ok: false, problem: { code: resolved.reason } } as const;
      }

      // A workspace reset removes the credential along with the checkout. Re-establish the same
      // unattended credential that connection uses before handing the repository to the clone
      // script. Best effort: a public repository clones without any credential, so a missing one
      // must not block it. A private repository without a credential fails in the clone step.
      yield* this.github.ensureCredential(Date.now(), signal);

      if (signal?.aborted === true) {
        return { ok: false, problem: { code: "provisioning-failed" } } as const;
      }

      const provisioned = yield* Effect.result(
        provisionProjectWorkspace({
          workspaceName: this.workspaceName,
          projectId: resolved.project.id,
          catalog,
          namespace: this.namespace,
          signal,
        }),
      );

      if (Result.isFailure(provisioned)) {
        const diskFailure =
          provisioned.failure instanceof ProvisionStepFailed &&
          provisioned.failure.step === "clone" &&
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
      timedWorkspaceRpc(
        { method: "project", step: "remove" },
        () =>
          removalNamespace.getByName(this.workspaceName).removeProject({
            kind: "remove-project",
            projectId,
          }),
        (answered) => {
          if (answered.ok && answered.result.kind === "command" && answered.result.exitCode === 0) {
            return { outcome: "removed" };
          }

          // `workspace-sync-incomplete` means the container deleted the clone but the durable
          // store may still hold it, so it can return with a replacement container. It is not a
          // removal.
          return { outcome: answered.ok ? "failed" : answered.error.code, level: "error" };
        },
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
