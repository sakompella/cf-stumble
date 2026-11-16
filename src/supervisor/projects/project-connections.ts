import * as Effect from "effect/Effect";
import { KeyedLock } from "../../keyed-lock.js";
import { ConnectedProjects } from "./connected-projects.js";
import { execute, markRemoving, recover } from "./project-lifecycle-commands.js";
import type { GitHubConnection } from "./github-connection.js";
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
import {
  logWorkspaceUnavailable,
  provisionOnUse,
  type ProvisionFence,
} from "../readiness/index.js";
import { removeProjectDirectories } from "./project-removal.js";

export type DisconnectRepositoryResult =
  | Readonly<{ ok: true; projectId: ProjectId; workspace: "removed" | "failed" }>
  | Readonly<{
      ok: false;
      problem: Readonly<{
        code: "invalid-project-id" | "unknown-project-id" | "run-active" | "workspace-busy";
      }>;
    }>;

type ReleaseProject = <Marked>(
  projectId: ProjectId,
  mark: () => Marked,
) => Effect.Effect<Readonly<{ marked: Marked }> | null>;

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
    }>
  | Readonly<{ ok: false; problem: ConnectRepositoryProblem }>
  | Readonly<{ ok: false; problem: Readonly<{ code: "workspace-busy"; detail: "" }> }>;

type ConnectionsNamespace = WorkspaceHostNamespace<
  | "installCredential"
  | "credentialStatus"
  | "checkRepositoryAccess"
  | "provision"
  | "build"
  | "ensureManagedInstructions"
  | "removeProject"
>;

interface ProjectConnectionsInput {
  readonly storage: DurableObjectStorage;
  readonly workspaceName: string;
  readonly fence: ProvisionFence;
  readonly namespace: ConnectionsNamespace;
  readonly github: GitHubConnection;
}

export class ProjectConnections {
  private readonly projects: ConnectedProjects;
  private readonly lifecycle = new KeyedLock<ProjectId>();
  private readonly github: GitHubConnection;
  private readonly workspaceName: string;
  private readonly fence: ProvisionFence;
  private readonly namespace: ConnectionsNamespace;

  constructor(input: ProjectConnectionsInput) {
    this.projects = new ConnectedProjects(input.storage);
    this.workspaceName = input.workspaceName;
    this.fence = input.fence;
    this.namespace = input.namespace;
    this.github = input.github;
  }

  catalog(): SelectableCatalog {
    return selectableCatalog(this.projects.catalog());
  }

  connect(repositoryUrl: string, now: number): Effect.Effect<ConnectRepositoryResult> {
    return Effect.gen({ self: this }, function* () {
      const canonical = canonicalRepositoryUrl(repositoryUrl);
      const projectId = canonical === undefined ? undefined : projectIdForRepository(canonical);

      if (canonical === undefined || projectId === undefined) {
        return refused({ code: "invalid-repository-url", detail: "" });
      }

      yield* this.sweep(projectId);

      const credentialRefusal = yield* this.github.ensureCredential(now).pipe(
        Effect.map(({ state }) =>
          state === "tooling-missing"
            ? refused({ code: "tooling-missing", detail: "" })
            : undefined,
        ),
        Effect.catchTag("CredentialWorkspaceUnavailable", (failure) =>
          Effect.succeed(refused({ code: "workspace-unavailable", detail: failure.detail })),
        ),
      );

      if (credentialRefusal !== undefined) return credentialRefusal;

      const accessRefusal = yield* checkRepositoryAccess({
        workspaceName: this.workspaceName,
        namespace: this.namespace,
        repositoryUrl: canonical,
      }).pipe(
        Effect.match({
          onFailure: (failure) =>
            refused({ code: "workspace-unavailable", detail: failure.detail }),
          onSuccess: (access) =>
            access.granted
              ? undefined
              : refused({ code: "repository-not-accessible", detail: access.detail }),
        }),
      );

      if (accessRefusal !== undefined) return accessRefusal;

      return yield* this.lifecycle.withLock(projectId, this.store(canonical, now));
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

      return yield* this.lifecycle.withLock(
        parsed,
        Effect.gen({ self: this }, function* () {
          if (this.projects.stateOf(parsed) === undefined) {
            return { ok: false, problem: { code: "unknown-project-id" } } as const;
          }

          const released = yield* release(parsed, () => markRemoving(this.projects, parsed));

          if (released === null) {
            return { ok: false, problem: { code: "run-active" } } as const;
          }

          const settled = yield* execute(this.effects(), parsed, released.marked);

          return {
            ok: true,
            projectId: parsed,
            workspace: settled.removal ?? "failed",
          } as const;
        }),
      );
    });
  }

  ensureProvisioned(projectId: ProjectId) {
    return this.lifecycle.withLock(
      projectId,
      this.provisionOnUse(() => this.projects.catalog(), projectId),
    );
  }

  private sweep(except: ProjectId): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      for (const { id } of this.projects.unfinished()) {
        if (id === except || this.lifecycle.busy(id)) continue;

        yield* this.lifecycle.withLock(id, recover(this.effects(), id));
      }
    });
  }

  private store(
    repositoryUrl: PublicRepositoryUrl,
    now: number,
  ): Effect.Effect<ConnectRepositoryResult> {
    return Effect.gen({ self: this }, function* () {
      const known = projectIdForRepository(repositoryUrl);

      if (known !== undefined && this.projects.stateOf(known) === "removing") {
        yield* recover(this.effects(), known);
      }

      const connected = this.projects.connect(repositoryUrl, now);

      if (!connected.ok) {
        return refused({ code: connected.problem.code, detail: "" });
      }

      if (connected.after === "removing") {
        return refused({
          code: "workspace-unavailable",
          detail: "the earlier clone of this repository is still being removed",
        });
      }

      const settled = yield* execute(this.effects(), connected.project.id, connected.commands);

      if (settled.provision !== undefined && !settled.provision.ok) {
        const { problem } = settled.provision;

        logWorkspaceUnavailable(problem);

        return refused(
          problem.code === "repository-too-large"
            ? {
                code: "repository-too-large",
                detail: `repository exceeds a workspace size limit: ${problem.detail}`,
              }
            : { code: "provisioning-failed", detail: problem.detail },
        );
      }

      return {
        ok: true,
        project: connected.project,
        alreadyConnected: connected.before === "connected",
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

  private provisionOnUse(catalog: () => ProjectCatalog, projectId: ProjectId) {
    return provisionOnUse(
      {
        workspaceName: this.workspaceName,
        fence: this.fence,
        namespace: this.namespace,
        github: this.github,
        catalog,
      },
      projectId,
    );
  }
}

function refused(problem: ConnectRepositoryProblem): ConnectRepositoryResult {
  return { ok: false, problem };
}
