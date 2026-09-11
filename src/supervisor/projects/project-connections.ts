/// <reference types="@cloudflare/workers-types" />

import { ConnectedProjects } from "./connected-projects.js";
import {
  GitHubConnection,
  type GitHubAuthorizationOutcome,
  type GitHubConnectionEnvironment,
  type GitHubConnectionStatus,
} from "./github-connection.js";
import { GitHubConnectionStore } from "./github-connection-store.js";
import {
  canonicalRepositoryUrl,
  resolveProject,
  type Project,
  type ProjectCatalog,
  type PublicRepositoryUrl,
} from "../../project-catalog.js";
import { selectableCatalog, type SelectableCatalog } from "../../selectable-projects.js";
import {
  checkRepositoryAccess,
  provisionProjectWorkspace,
  type CredentialWorkspaceNamespace,
  type ProvisionWorkspaceNamespace,
} from "../../workspace/index.js";
import type { VerifiedAccessScope } from "../../access/index.js";

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
export type ProjectListView = Readonly<{
  projects: SelectableCatalog;
  github: GitHubConnectionStatus;
}>;

export type ConnectRepositoryProblem = Readonly<{
  code:
    | "invalid-repository-url"
    | "project-id-conflict"
    | "repository-not-accessible"
    | "workspace-unavailable"
    | "tooling-missing"
    | "provisioning-failed";
  detail: string;
}>;

export type ConnectRepositoryResult =
  | Readonly<{
      ok: true;
      project: Project;
      alreadyConnected: boolean;
      github: GitHubConnectionStatus;
    }>
  | Readonly<{ ok: false; problem: ConnectRepositoryProblem; github: GitHubConnectionStatus }>;

/** Why a project could not be provisioned when it was used. */
export type ProjectUseProblem = Readonly<{
  code: "invalid-project-id" | "unknown-project-id" | "provisioning-failed";
}>;

export type ProjectUseResult =
  | Readonly<{ ok: true; project: Project }>
  | Readonly<{ ok: false; problem: ProjectUseProblem }>;

export interface ProjectConnectionsInput {
  readonly storage: DurableObjectStorage;
  /** The tenant's one workspace, named server-side. See `workspace-names.ts`. */
  readonly workspaceName: string;
  readonly namespace: CredentialWorkspaceNamespace & ProvisionWorkspaceNamespace;
  readonly environment: GitHubConnectionEnvironment;
}

export class ProjectConnections {
  private readonly projects: ConnectedProjects;
  private readonly github: GitHubConnection;
  private readonly workspaceName: string;
  private readonly namespace: CredentialWorkspaceNamespace & ProvisionWorkspaceNamespace;

  constructor(input: ProjectConnectionsInput) {
    this.projects = new ConnectedProjects(input.storage);
    this.workspaceName = input.workspaceName;
    this.namespace = input.namespace;
    this.github = new GitHubConnection({
      store: new GitHubConnectionStore(input.storage),
      workspaceName: input.workspaceName,
      namespace: input.namespace,
      environment: input.environment,
    });
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
   * The page's list: everything selectable, and a connection status that carries no credential.
   *
   * The harness entry is in it and has no repository URL, which is what tells the sidebar that
   * this one is not a connection: there is nothing to authorize and nothing to clone.
   */
  async list(now: number): Promise<ProjectListView> {
    return { projects: this.catalog(), github: await this.github.status(now) };
  }

  connectionStatus(now: number): Promise<GitHubConnectionStatus> {
    return this.github.status(now);
  }

  /**
   * Make the workspace's credential usable if that is possible without a human, and report what it
   * can do. A turn and a connection both want this before they touch a repository.
   */
  ensureCredential(now: number): Promise<GitHubConnectionStatus> {
    return this.github.ensureCredential(now);
  }

  startAuthorization(scope: VerifiedAccessScope, now: number): Promise<GitHubAuthorizationOutcome> {
    return this.github.startAuthorization(scope, now);
  }

  completeAuthorization(
    scope: VerifiedAccessScope,
    now: number,
  ): Promise<GitHubAuthorizationOutcome> {
    return this.github.completeAuthorization(scope, now);
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
  async connect(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the repository URL arrives from a client.
    repositoryUrl: unknown,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the display name arrives from a client.
    displayName: unknown,
    now: number,
  ): Promise<ConnectRepositoryResult> {
    const github = await this.github.ensureCredential(now);

    if (github.state === "tooling-missing") {
      return this.refused({ code: "tooling-missing", detail: "" }, github);
    }

    const canonical = canonicalRepositoryUrl(repositoryUrl);

    if (canonical === undefined) {
      return this.refused({ code: "invalid-repository-url", detail: "" }, github);
    }

    const access = await checkRepositoryAccess({
      workspaceName: this.workspaceName,
      namespace: this.namespace,
      repositoryUrl: canonical,
    });

    if (access.isErr()) {
      return this.refused(
        {
          code:
            access.error.code === "credential-workspace-unavailable"
              ? "workspace-unavailable"
              : "repository-not-accessible",
          detail: access.error.detail,
        },
        github,
      );
    }

    if (!access.value.granted) {
      return this.refused(
        { code: "repository-not-accessible", detail: access.value.detail },
        github,
      );
    }

    return this.store(canonical, displayName, github, now);
  }

  /**
   * Provision a project because it is about to be used. Every run performs every step, so this is
   * also what repairs a workspace the platform recreated: the state that matters is in the
   * workspace, and nothing here remembers having provisioned before.
   */
  async ensureProvisioned(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the project id arrives from a client.
    projectId: unknown,
  ): Promise<ProjectUseResult> {
    // The connected repositories alone: provisioning clones a repository URL, and the harness
    // entry has none. A turn on the harness never reaches here (`project-turn.ts`).
    const catalog: ProjectCatalog = this.projects.catalog();
    const resolved = resolveProject(projectId, catalog);

    if (!resolved.ok) {
      return { ok: false, problem: { code: resolved.reason } };
    }

    const provisioned = await provisionProjectWorkspace({
      workspaceName: this.workspaceName,
      projectId: resolved.project.id,
      catalog,
      namespace: this.namespace,
    });

    return provisioned.isErr()
      ? { ok: false, problem: { code: "provisioning-failed" } }
      : { ok: true, project: resolved.project };
  }

  private async store(
    repositoryUrl: PublicRepositoryUrl,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: see `connect`.
    displayName: unknown,
    github: GitHubConnectionStatus,
    now: number,
  ): Promise<ConnectRepositoryResult> {
    const connected = this.projects.connect({ repositoryUrl, displayName }, now);

    if (!connected.ok) {
      return this.refused({ code: connected.problem.code, detail: "" }, github);
    }

    const provisioned = await this.ensureProvisioned(connected.project.id);

    if (!provisioned.ok) {
      if (!connected.alreadyConnected) {
        this.projects.disconnect(connected.project.id);
      }

      return this.refused({ code: "provisioning-failed", detail: "" }, github);
    }

    return {
      ok: true,
      project: connected.project,
      alreadyConnected: connected.alreadyConnected,
      github,
    };
  }

  private refused(
    problem: ConnectRepositoryProblem,
    github: GitHubConnectionStatus,
  ): ConnectRepositoryResult {
    return { ok: false, problem, github };
  }
}
