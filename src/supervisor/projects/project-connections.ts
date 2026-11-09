import * as Effect from "effect/Effect";
import { ConnectedProjects } from "./connected-projects.js";
import { disconnect, execute, recover } from "./project-lifecycle-commands.js";
import { ProjectLifecycleQueue } from "./project-lifecycle-queue.js";
import type { GitHubConnection, GitHubConnectionStatus } from "./github-connection.js";
import {
  canonicalRepositoryUrl,
  parseProjectId,
  projectIdForRepository,
  type Project,
  type ProjectCatalog,
  type ProjectId,
  type PublicRepositoryUrl,
} from "../../project-catalog.js";
import { selectableCatalog, type SelectableCatalog } from "../../selectable-projects.js";
import { checkRepositoryAccess, type WorkspaceHostNamespace } from "../../workspace/index.js";
import { provisionOnUse } from "../readiness/index.js";
import { removeProjectDirectories } from "./project-removal.js";

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

type ConnectionsNamespace = WorkspaceHostNamespace<
  "credential" | "provision" | "build" | "ensureManagedInstructions" | "removeProject"
>;

interface ProjectConnectionsInput {
  readonly storage: DurableObjectStorage;
  readonly workspaceName: string;
  readonly namespace: ConnectionsNamespace;
  readonly github: GitHubConnection;
}

export class ProjectConnections {
  private readonly projects: ConnectedProjects;
  private readonly lifecycle = new ProjectLifecycleQueue();
  private readonly github: GitHubConnection;
  private readonly workspaceName: string;
  private readonly namespace: ConnectionsNamespace;

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

      yield* this.sweep(projectId);

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

    return Effect.gen({ self: this }, function* () {
      yield* this.sweep(parsed);

      return yield* this.lifecycle.exclusive(
        parsed,
        Effect.gen({ self: this }, function* () {
          if (this.projects.stateOf(parsed) === undefined) {
            return { ok: false, problem: { code: "unknown-project-id" } } as const;
          }

          if (!release(parsed)) {
            return { ok: false, problem: { code: "run-active" } } as const;
          }

          const settled = yield* disconnect(this.effects(), parsed);

          return {
            ok: true,
            projectId: parsed,
            workspace: settled.removal ?? "failed",
          } as const;
        }),
      );
    });
  }

  ensureProvisioned(projectId: ProjectId, signal?: AbortSignal) {
    return this.lifecycle.exclusive(
      projectId,
      this.provisionOnUse(() => this.projects.catalog(), projectId, signal),
    );
  }

  private sweep(except: ProjectId): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      for (const { id } of this.projects.unfinished()) {
        if (id === except || this.lifecycle.busy(id)) continue;

        yield* this.lifecycle.exclusive(id, recover(this.effects(), id));
      }
    });
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

      const settled = yield* execute(this.effects(), connected.project.id, connected.commands);

      if (settled.provision !== undefined && !settled.provision.ok) {
        return this.refused(
          {
            code:
              settled.provision.problem.code === "repository-too-large"
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
        alreadyConnected: connected.before === "connected",
        github,
        checkedAt: this.github.checkedAt(),
      } as const;
    });
  }

  private effects() {
    return {
      projects: this.projects,
      provision: (projectId: ProjectId) =>
        this.provisionOnUse(() => this.projects.provisionable(), projectId),
      remove: (projectId: ProjectId) =>
        removeProjectDirectories(this.namespace, this.workspaceName, projectId),
    };
  }

  private provisionOnUse(
    catalog: () => ProjectCatalog,
    projectId: ProjectId,
    signal?: AbortSignal,
  ) {
    return provisionOnUse(
      {
        workspaceName: this.workspaceName,
        namespace: this.namespace,
        github: this.github,
        catalog,
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
