// oxlint-disable import/max-dependencies -- Workspace Host owns the platform and all workspace surfaces.

// oxlint-disable max-lines -- The Workspace Host class exposes one narrow method per workspace capability.

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
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { WorkspaceResult } from "./decisions.js";
import type { WorkspacePathKind } from "./executor.js";
import { logEvent, logRedactedCause, parseRequestId, timedEffect } from "../diagnostics.js";
import { MANAGED_AGENT_INSTRUCTIONS } from "../project-provision.js";
import { MANAGED_AGENT_INSTRUCTIONS_PATH, WORKSPACE_ROOT } from "../workspace-layout.js";
import { ObservedWorkspaceContainer } from "./container-observer.js";
import { ComputerWorkspaceOperations } from "./computer-operations.js";
import {
  executeHarnessBuildRequest,
  executeProjectProvisionRequest,
  executeProjectRemovalRequest,
} from "./executor.js";
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
import { PROJECT_TURN_LEASE_MS } from "../turn-budget.js";
import { ContainerLifecycle } from "./container-lifecycle.js";
import { afterIdleStop, trackedWork, WorkspaceIdleController } from "./idle-controller.js";
import { answerFailures, attemptWorkspace } from "./operations.js";
import { runAtEntryPoint } from "../run-entry-point.js";
import { WORKSPACE_IDLE_STOP_MS } from "./idle-stop.js";
import { withWorkspaceSyncIgnore } from "./backend-sync-ignore.js";
import { observeBackendClose, type BackendCloseTrigger } from "./container-exit.js";

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
const WORKSPACE_CONTAINER_RESET_SPEC = {
  env: { PORT: "8080", MOUNT_POINT: "/workspace" },
  enableInternet: true,
} as const satisfies ContainerLaunchSpec;

/**
 * Clear the authoritative workspace rows before replacing the container that mirrors them. The
 * storage belongs to this Workspace Host, and the restart destroys the old container replica so it
 * cannot push the deleted files back on a later workspace operation.
 */
export function resetWorkspaceStorage(
  storage: WorkspaceStorageReset,
  container: WorkspaceContainerReset,
): Effect.Effect<WorkspaceResetResult> {
  // A step that rejects is a defect: the reset RPC rejects with what it threw, as it always has.
  return Effect.promise(() => storage.deleteAll()).pipe(
    timedEffect("workspace.reset-step", { step: "delete-all" }, () => ({ outcome: "ok" })),
    Effect.andThen(
      Effect.sync(() => {
        logEvent("info", "workspace.container.stop-requested", { reasonCode: "workspace-reset" });
      }),
    ),
    Effect.andThen(
      Effect.promise(() => container.restart(WORKSPACE_CONTAINER_RESET_SPEC)).pipe(
        timedEffect("workspace.reset-step", { step: "restart-container" }, (restarted) => ({
          outcome: Result.isSuccess(restarted) ? restarted.success.outcome : "threw",
        })),
      ),
    ),
    Effect.as({ ok: true, reset: "workspace" } as const),
  );
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

/** Restore the managed instructions after reset, without replacing an existing file. */
type ManagedInstructionOperations = Readonly<{
  lstat(path: string): Promise<WorkspacePathKind | undefined>;
  writeFile(path: string, content: string): Promise<void>;
}>;

export function ensureManagedInstructions(
  operations: ManagedInstructionOperations,
): Effect.Effect<WorkspaceResult> {
  const lstat = (path: string) => attemptWorkspace(() => operations.lstat(path));

  return Effect.gen(function* () {
    for (const path of [WORKSPACE_ROOT, MANAGED_AGENT_INSTRUCTIONS_PATH]) {
      if ((yield* lstat(path)) === "symbolic-link") {
        return { ok: false, error: { code: "path-outside-root" } } as const;
      }
    }

    const existing = yield* lstat(MANAGED_AGENT_INSTRUCTIONS_PATH);

    if (existing === undefined) {
      yield* attemptWorkspace(() =>
        operations.writeFile(MANAGED_AGENT_INSTRUCTIONS_PATH, MANAGED_AGENT_INSTRUCTIONS),
      );
    } else if (existing !== "file") {
      return { ok: false, error: { code: "workspace-unavailable" } } as const;
    }

    return { ok: true, result: { kind: "written" } } as const;
  }).pipe(
    answerFailures((thrown): WorkspaceResult => {
      logRedactedCause("workspace.managed-instructions: workspace-unavailable", thrown);

      return { ok: false, error: { code: "workspace-unavailable" } };
    }),
  );
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
  readonly #container: ObservedWorkspaceContainer;
  readonly #idle: WorkspaceIdleController;
  readonly #containerLifecycle = new ContainerLifecycle();

  constructor(ctx: DurableObjectState, env: WorkspaceHostEnv) {
    super(ctx, env);
    const platformContainer = ctx.container;

    this.#container = new ObservedWorkspaceContainer(new WorkspaceContainerAPI(ctx), {
      monitor: platformContainer === undefined ? undefined : () => platformContainer.monitor(),
      destroy:
        platformContainer === undefined ? undefined : (reason) => platformContainer.destroy(reason),
    });
    this.#containerBackend = new CloudflareContainerBackend({
      container: () => ({ getWorkspaceContainer: () => this.#container }),
      ...workspaceContainerBackendConfiguration(ctx.id.toString()),
    });
    this.#workspaceBackend = withWorkspaceSyncIgnore(this.#containerBackend, {
      connected: (runtimeId) => {
        this.#containerLifecycle.connected(runtimeId);
        logEvent("info", "workspace.backend.connected", { runtimeId: runtimeId ?? null });
      },
      closed: () => {
        // The close an idle stop causes is its own doing, and is named so.
        void this.#observeContainerClose(this.#idle.stopping() ? "idle-stop" : "transport-closed");
      },
      failed: () => {
        void this.#observeContainerClose("connect-failed");
      },
    });
    this.#workspace = this.#newWorkspace();
    this.#idle = new WorkspaceIdleController({
      nowMs: () => Date.now(),
      idleLimitMs: WORKSPACE_IDLE_STOP_MS,
      setAlarm: (atMs) => ctx.storage.setAlarm(atMs),
      containerRunning: () => platformContainer?.running ?? false,
      closeWorkspace: () => this.#workspace.close(),
      stopContainer: async () => {
        await this.#container.stopFor("idle");
        this.#containerLifecycle.stoppedByHost();
      },
    });
  }

  /** Run one Host RPC as work in flight, so the idle check never counts it as quiet time. */
  #tracked<A>(work: () => Effect.Effect<A>): Promise<A> {
    return runAtEntryPoint(trackedWork(this.#idle, Effect.suspend(work)));
  }

  #observeContainerClose(trigger: BackendCloseTrigger): Promise<void> {
    return observeBackendClose(this.#container, trigger, () => {
      this.#containerLifecycle.replaced();
    });
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
    return this.#tracked(() =>
      executeHarnessBuildRequest({
        configuration: harnessBuildConfiguration(this.env.HARNESS_REPOSITORY_URL),
        operations: new ComputerWorkspaceOperations(this.#workspace, "not-required"),
        request,
      }),
    );
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
    return this.#tracked(() =>
      executeProjectProvisionRequest({
        operations: new ComputerWorkspaceOperations(this.#workspace, "require-complete"),
        request,
      }),
    );
  }

  /** Remove one connected project's clone and provisioning remnants, never the harness. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The RPC parser validates this boundary.
  removeProject(request: unknown): Promise<WorkspaceResult> {
    return this.#tracked(() =>
      executeProjectRemovalRequest({
        operations: new ComputerWorkspaceOperations(this.#workspace, "require-complete"),
        request,
      }),
    );
  }

  /** Restore the managed instructions after a workspace reset, without replacing an existing file. */
  ensureManagedInstructions(): Promise<WorkspaceResult> {
    return this.#tracked(() =>
      ensureManagedInstructions(new ComputerWorkspaceOperations(this.#workspace, "not-required")),
    );
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
   *
   * The install requires a complete sync of the workspace's durable copy: `hosts.yml` now lives
   * under the workspace root, and a copy that is still pending would be lost with the container.
   * Status and the repository check change nothing, so they do not wait for a sync.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Durable Object RPC input is untrusted.
  credential(request: unknown, requestId?: unknown): Promise<GitHubCredentialResult> {
    return this.#tracked(() =>
      executeGitHubCredentialRequest({
        operations: new ComputerWorkspaceOperations(this.#workspace, "not-required"),
        installOperations: new ComputerWorkspaceOperations(this.#workspace, "require-complete"),
        request,
        requestId: parseRequestId(requestId),
      }),
    );
  }

  /** Owner reset: wipe this workspace's durable rows, then replace the container that mirrors them. */
  reset(): Promise<WorkspaceResetResult> {
    return this.#tracked(() =>
      resetWorkspaceStorage(this.ctx.storage, {
        restart: (spec) => this.#container.restartFor("workspace-reset", spec),
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            // deleteAll dropped the Workspace's own tables ("no such table: _vfs_watermark" on the
            // deployment); rebuild it so the next operation recreates them instead of failing.
            this.#workspace = this.#newWorkspace();

            // It may also have dropped the idle alarm (the `delete_all_deletes_alarm` compatibility
            // flag), so forget the one this instance armed; the end of this call arms a new one.
            this.#idle.forgetAlarm();
          }),
        ),
      ),
    );
  }

  /** Hand out a project capability bounded to one turn and this container generation. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Durable Object RPC input is untrusted.
  project(budget?: unknown): ProjectRpcTarget {
    const remainingMs = parseProjectBudget(budget);
    const options = remainingMs === undefined ? {} : { remainingMs };

    // Work can arrive until the turn's deadline, and the quiet period starts after it.
    this.#idle.leaseUntil(Date.now() + (remainingMs ?? PROJECT_TURN_LEASE_MS));

    return new ProjectRpcTarget(
      computerFilesystemProvider(this.#workspace),
      durableObjectTransactions(this.ctx.storage),
      afterIdleStop(
        this.#idle,
        computerExecBackend(this.#workspace, "container-shell", this.#containerLifecycle),
      ),
      { ...options, containerState: this.#containerLifecycle, activity: this.#idle },
    );
  }

  override fetch(request: Request): Promise<Response> {
    return this.#containerBackend.handleFetch(request);
  }

  /** The idle check. The RPC WebSocket from computerd is not work, so it never delays a stop. */
  override alarm(alarmInfo?: { retryCount?: number }): Promise<void> {
    return runAtEntryPoint(this.#idle.onAlarm(alarmInfo?.retryCount ?? 0));
  }
}
