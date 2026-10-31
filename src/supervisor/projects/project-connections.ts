import * as Effect from "effect/Effect";
import { ConnectedProjects } from "./connected-projects.js";
import { ProjectLifecycleQueue } from "./project-lifecycle-queue.js";
import type { GitHubConnection, GitHubConnectionStatus } from "./github-connection.js";
import {
  canonicalRepositoryUrl,
  parseProjectId,
  projectIdForRepository,
  resolveProject,
  type Project,
  type ProjectId,
  type PublicRepositoryUrl,
} from "../../project-catalog.js";
import { selectableCatalog, type SelectableCatalog } from "../../selectable-projects.js";
import {
  checkRepositoryAccess,
  clearWorkspaceProvision,
  type CredentialWorkspaceNamespace,
  type HarnessProvisionWorkspaceNamespace,
  type ProvisionWorkspaceNamespace,
  type ProjectRemovalWorkspaceNamespace,
} from "../../workspace/index.js";
import { removeProjectDirectories } from "./project-removal.js";
import { provisionOnUse } from "./provision-on-use.js";

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

interface ProjectConnectionsInput {
  readonly storage: DurableObjectStorage;
  readonly workspaceName: string;
  readonly namespace: CredentialWorkspaceNamespace &
    ProvisionWorkspaceNamespace &
    HarnessProvisionWorkspaceNamespace &
    ProjectRemovalWorkspaceNamespace;
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

  constructor(input: ProjectConnectionsInput) {
    this.projects = new ConnectedProjects(input.storage);
    this.workspaceName = input.workspaceName;
    this.namespace = input.namespace;
    this.github = input.github;
  }

  catalog(): SelectableCatalog {
    return selectableCatalog(this.projects.catalog());
  }

  connect(
    repositoryUrl: string,
    displayName: string | undefined,
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

      const github = yield* this.github.ensureCredential(now);

      if (github.state === "tooling-missing") {
        return this.refused({ code: "tooling-missing", detail: "" }, github);
      }

      const accessRefusal = yield* checkRepositoryAccess({
        workspaceName: this.workspaceName,
        namespace: this.namespace,
        repositoryUrl: canonical,
      }).pipe(
        Effect.match({
          onFailure: (failure) =>
            this.refused({ code: "workspace-unavailable", detail: failure.detail }, github),
          onSuccess: (access) =>
            access.granted
              ? undefined
              : this.refused({ code: "repository-not-accessible", detail: access.detail }, github),
        }),
      );

      if (accessRefusal !== undefined) return accessRefusal;

      return yield* this.lifecycle.exclusive(
        projectId,
        this.store(canonical, displayName, github, now),
      );
    });
  }

  disconnect(
    projectId: string,
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

        const workspace = yield* removeProjectDirectories(
          this.namespace,
          this.workspaceName,
          resolved.project.id,
        );

        return { ok: true, projectId: resolved.project.id, workspace } as const;
      }),
    );
  }

  resetWorkspace(): void {
    clearWorkspaceProvision(this.workspaceName);
    this.github.resetWorkspace();
  }

  ensureProvisioned(projectId: ProjectId, signal?: AbortSignal) {
    return this.lifecycle.exclusive(projectId, this.provisionOnUse(projectId, signal));
  }

  private store(
    repositoryUrl: PublicRepositoryUrl,
    displayName: string | undefined,
    github: GitHubConnectionStatus,
    now: number,
  ): Effect.Effect<ConnectRepositoryResult> {
    return Effect.gen({ self: this }, function* () {
      const connected = this.projects.connect({ repositoryUrl, displayName }, now);

      if (!connected.ok) {
        return this.refused({ code: connected.problem.code, detail: "" }, github);
      }

      const provisioned = yield* this.provisionOnUse(connected.project.id);

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

  private provisionOnUse(projectId: ProjectId, signal?: AbortSignal) {
    return provisionOnUse(
      {
        workspaceName: this.workspaceName,
        namespace: this.namespace,
        github: this.github,
        catalog: () => this.projects.catalog(),
      },
      projectId,
      signal,
    );
  }

  private refused(
    problem: ConnectRepositoryProblem,
    github: GitHubConnectionStatus,
  ): ConnectRepositoryResult {
    return { ok: false, problem, github, checkedAt: this.github.checkedAt() };
  }
}
