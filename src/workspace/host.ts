// oxlint-disable import/max-dependencies -- Workspace Host owns the platform and all workspace surfaces.
/// <reference types="@cloudflare/workers-types" />

import {
  Workspace,
  type DurableObjectStorageLike,
  type WorkspaceBackend,
} from "@cloudflare/computer";
import {
  CloudflareContainerBackend,
  type CloudflareContainerBackendOptions,
  type ContainerLaunchSpec,
  type ContainerRuntimeInfo,
  WorkspaceContainerAPI,
} from "@cloudflare/computer/backends/container";
import { DurableObject } from "cloudflare:workers";
import type { WorkspaceResult } from "./decisions.js";
import type { WorkspacePathKind } from "./executor.js";
import { logEvent, logRedactedCause, timed } from "../diagnostics.js";
import { MANAGED_AGENT_INSTRUCTIONS } from "../project-provision.js";
import { MANAGED_AGENT_INSTRUCTIONS_PATH, WORKSPACE_ROOT } from "../workspace-layout.js";
import { ComputerWorkspaceOperations } from "./computer-operations.js";
import { executeHarnessBuildRequest, executeProjectProvisionRequest } from "./executor.js";
import {
  executeGitHubCredentialRequest,
  type GitHubCredentialResult,
} from "./github-credential.js";
import {
  computerExecBackend,
  computerFilesystemProvider,
  durableObjectTransactions,
  ProjectRpcTarget,
  parseProjectBudget,
} from "./project/index.js";
import { harnessBuildConfiguration } from "../harness-build.js";
import {
  recordWorkspaceContainerClosed,
  withWorkspaceSyncIgnore,
  type WorkspaceBackendLifecycle,
} from "./backend-sync-ignore.js";

export { parseProjectBudget };

export type WorkspaceResetResult = Readonly<{
  ok: true;
  reset: "workspace";
}>;

type WorkspaceStorageReset = Readonly<{
  deleteAll(): Promise<void>;
}>;

type WorkspaceContainerReset = Readonly<{
  restart(spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo>;
}>;

/** The same launch settings the container backend uses for a fresh workspace connection. */
export const WORKSPACE_CONTAINER_RESET_SPEC = {
  env: { PORT: "8080", MOUNT_POINT: "/workspace" },
  enableInternet: true,
} as const satisfies ContainerLaunchSpec;

/**
 * Clear the authoritative workspace rows before replacing the container that mirrors them. The
 * storage belongs to this Workspace Host, and the restart destroys the old container replica so it
 * cannot push the deleted files back on a later workspace operation.
 */
export async function resetWorkspaceStorage(
  storage: WorkspaceStorageReset,
  container: WorkspaceContainerReset,
): Promise<WorkspaceResetResult> {
  await timed(
    "workspace.reset-step",
    { step: "delete-all" },
    () => storage.deleteAll(),
    () => ({ outcome: "ok" }),
  );
  logEvent("info", "workspace.container.stopped", {
    outcome: "stopped",
    reasonCode: "workspace-reset",
    exitCode: null,
    signal: null,
    running: true,
  });

  const runtime = await timed(
    "workspace.reset-step",
    { step: "restart-container" },
    () => container.restart(WORKSPACE_CONTAINER_RESET_SPEC),
    (value) => ({ outcome: value.outcome }),
  );

  logEvent("info", "workspace.container.started", {
    outcome: runtime.outcome,
    runtimeId: runtime.runtimeId,
    reasonCode: null,
    exitCode: null,
    signal: null,
  });

  return { ok: true, reset: "workspace" };
}

interface WorkspaceHostEnv {
  /** The harness repository this deployment builds from. See `harness-build.ts`. */
  readonly HARNESS_REPOSITORY_URL?: string;
}

export function workspaceContainerBackendConfiguration(
  workspaceId: string,
): Pick<CloudflareContainerBackendOptions, "egress" | "workspace"> {
  return {
    workspace: { binding: "WORKSPACE_HOST", id: workspaceId },
    egress: { mode: "direct" },
  };
}

function computerStorage(storage: DurableObjectStorage): DurableObjectStorageLike {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Computer 0.3.0 accepts the same Durable Object SQLite API; its generic cursor declaration is narrower than @cloudflare/workers-types.
  return storage as DurableObjectStorageLike;
}

/** Keep the backend decoration at the Workspace Host construction seam. */
export function workspaceBackendForHost(
  backend: WorkspaceBackend,
  lifecycle?: WorkspaceBackendLifecycle,
): WorkspaceBackend {
  return withWorkspaceSyncIgnore(backend, lifecycle);
}

/** Restore the managed instructions after reset, without replacing an existing file. */
type ManagedInstructionOperations = Readonly<{
  lstat(path: string): Promise<WorkspacePathKind | undefined>;
  writeFile(path: string, content: string): Promise<void>;
}>;

export async function ensureManagedInstructions(
  operations: ManagedInstructionOperations,
): Promise<WorkspaceResult> {
  try {
    for (const path of [WORKSPACE_ROOT, MANAGED_AGENT_INSTRUCTIONS_PATH]) {
      if ((await operations.lstat(path)) === "symbolic-link") {
        return { ok: false, error: { code: "path-outside-root" } };
      }
    }

    const existing = await operations.lstat(MANAGED_AGENT_INSTRUCTIONS_PATH);

    if (existing === undefined) {
      await operations.writeFile(MANAGED_AGENT_INSTRUCTIONS_PATH, MANAGED_AGENT_INSTRUCTIONS);
    } else if (existing !== "file") {
      return { ok: false, error: { code: "workspace-unavailable" } };
    }

    return { ok: true, result: { kind: "written" } };
  } catch (cause) {
    logRedactedCause("workspace.managed-instructions: workspace-unavailable", cause);

    return { ok: false, error: { code: "workspace-unavailable" } };
  }
}

/**
 * The one durable Computer workspace a tenant owns (ADR-0038). It holds the harness repository,
 * every connected project repository, and the build scratch subtree as separate directories, and
 * the Supervisor names it from its own server-derived tenant key.
 *
 * Its RPC surface returns plain values and one narrow project capability; it never returns the
 * workspace, its container API, or a credential-bearing binding.
 */
export class WorkspaceHost extends DurableObject<WorkspaceHostEnv> {
  #workspace: Workspace;
  readonly #containerBackend: CloudflareContainerBackend;
  readonly #workspaceBackend: WorkspaceBackend;
  readonly #container: WorkspaceContainerAPI;
  readonly #containerLifecycle = { generation: 0 };

  constructor(ctx: DurableObjectState, env: WorkspaceHostEnv) {
    super(ctx, env);
    this.#container = new WorkspaceContainerAPI(ctx);
    this.#containerBackend = new CloudflareContainerBackend({
      container: () => ({ getWorkspaceContainer: () => this.#container }),
      ...workspaceContainerBackendConfiguration(ctx.id.toString()),
    });
    this.#workspaceBackend = workspaceBackendForHost(this.#containerBackend, {
      connected: (runtimeId) => {
        logEvent("info", "workspace.container.started", {
          outcome: "started",
          runtimeId: runtimeId ?? null,
          reasonCode: null,
          exitCode: null,
          signal: null,
        });
      },
      closed: () => {
        this.#containerLifecycle.generation += 1;
        void recordWorkspaceContainerClosed(this.#container);
      },
      failed: () => {
        this.#containerLifecycle.generation += 1;
        void recordWorkspaceContainerClosed(this.#container);
      },
    });
    this.#workspace = this.#newWorkspace();
  }

  /** A Workspace creates its SQLite tables when constructed, so a wiped store needs a new one. */
  #newWorkspace(): Workspace {
    return new Workspace({
      storage: computerStorage(this.ctx.storage),
      sessionId: this.ctx.id.toString(),
      backends: [this.#workspaceBackend],
    });
  }

  /**
   * Build one labeled harness commit. This surface carries only the planned build steps, so a
   * caller names a commit and a step and never supplies command text. A build extracts into the
   * scratch subtree `workspace-layout.ts` reserves for it, which holds no repository, so a build
   * writes inside no project clone and never inside the editable harness checkout.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Durable Object RPC input is untrusted.
  build(request: unknown): Promise<WorkspaceResult> {
    return executeHarnessBuildRequest({
      configuration: harnessBuildConfiguration(this.env.HARNESS_REPOSITORY_URL),
      operations: new ComputerWorkspaceOperations(this.#workspace),
      request,
    });
  }

  /**
   * Reconcile this workspace against the repository the catalog names for a project, and rewrite
   * the managed agent instructions.
   *
   * This is a surface of its own rather than a step of the build surface. Each surface parses
   * only its own request and plans from its own configuration, so a build can never reach a
   * project clone and a provision can never reach the harness build root.
   *
   * A caller names a project and a planned step. The repository URL and the directory are both
   * resolved from the catalog on this side, so no caller can point a clone at a URL or a place of
   * its own.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Durable Object RPC input is untrusted.
  provision(request: unknown): Promise<WorkspaceResult> {
    return executeProjectProvisionRequest({
      operations: new ComputerWorkspaceOperations(this.#workspace),
      request,
    });
  }

  /** Restore the managed instructions after a workspace reset, without replacing an existing file. */
  ensureManagedInstructions(): Promise<WorkspaceResult> {
    return ensureManagedInstructions(new ComputerWorkspaceOperations(this.#workspace));
  }

  /**
   * Install, inspect, or exercise this workspace's GitHub credential.
   *
   * This is where a token enters the workspace and stops. The install hands it to `gh` on standard
   * input, so it is in no command line and on no filesystem; from then on the credential lives in
   * the ordinary local `gh` configuration and Git's helper reads it (ADR-0039). Nothing this
   * surface returns carries a token: an install answers with a word, a status with a state and at
   * most a login name, and a failure with redacted text.
   *
   * It is a surface of its own for the same reason provisioning is: a credential install is
   * neither a build step nor a provisioning step, and each surface parses only its own request,
   * so neither of the others can be asked to install, read, or exercise a token.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Durable Object RPC input is untrusted.
  credential(request: unknown): Promise<GitHubCredentialResult> {
    return executeGitHubCredentialRequest({
      operations: new ComputerWorkspaceOperations(this.#workspace),
      request,
    });
  }

  /** Owner reset: wipe this workspace's durable rows, then replace the container that mirrors them. */
  async reset(): Promise<WorkspaceResetResult> {
    const result = await resetWorkspaceStorage(this.ctx.storage, this.#container);
    // deleteAll dropped the Workspace's own tables ("no such table: _vfs_watermark" on the
    // deployment); rebuild it so the next operation recreates them instead of failing.
    this.#workspace = this.#newWorkspace();

    return result;
  }

  /** Hand out a project capability bounded to one turn and this container generation. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Durable Object RPC input is untrusted.
  project(budget?: unknown): ProjectRpcTarget {
    const remainingMs = parseProjectBudget(budget);
    const options = remainingMs === undefined ? {} : { remainingMs };

    return new ProjectRpcTarget(
      computerFilesystemProvider(this.#workspace),
      durableObjectTransactions(this.ctx.storage),
      computerExecBackend(this.#workspace, "container-shell", this.#containerLifecycle),
      { ...options, containerState: this.#containerLifecycle },
    );
  }

  override fetch(request: Request): Promise<Response> {
    return this.#containerBackend.handleFetch(request);
  }
}
