// oxlint-disable import/max-dependencies -- Workspace Host owns the platform and all workspace surfaces.

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
import type { WorkspaceResult } from "./decisions.js";
import type { WorkspacePathKind } from "./executor.js";
import { logEvent, logRedactedCause } from "../diagnostics.js";
import { MANAGED_AGENT_INSTRUCTIONS } from "../project-provision.js";
import { MANAGED_AGENT_INSTRUCTIONS_PATH, WORKSPACE_ROOT } from "../workspace-layout.js";
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

export { parseProjectBudget };

export type WorkspaceResetResult =
  | Readonly<{ ok: true; reset: "workspace" }>
  | Readonly<{ ok: false; problem: Readonly<{ code: "workspace-busy" }> }>;

const WORKSPACE_BUSY = { ok: false, problem: { code: "workspace-busy" } } as const;

const CHANGE_REFUSED = { ok: false, error: { code: "workspace-busy" } } as const;

const CREDENTIAL_REFUSED = {
  ok: false,
  error: { code: "workspace-unavailable", detail: "the workspace is resetting" },
} as const;

type WorkspaceStorageReset = Readonly<{
  deleteAll(): Promise<void>;
}>;

type WorkspaceContainerReset = Readonly<{
  restart(spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo>;
}>;

/** Must match the launch settings the container backend uses. */
const WORKSPACE_CONTAINER_RESET_SPEC = {
  env: { PORT: "8080", MOUNT_POINT: "/workspace" },
  enableInternet: true,
} as const satisfies ContainerLaunchSpec;

/** Restarting destroys the old container replica, so it cannot push the deleted files back. */
export function resetWorkspaceStorage(
  storage: WorkspaceStorageReset,
  container: WorkspaceContainerReset,
): Effect.Effect<WorkspaceResetResult> {
  // A rejecting step is a defect: the reset RPC rejects with what it threw.
  return Effect.promise(async () => {
    await storage.deleteAll();
    const restarted = await container.restart(WORKSPACE_CONTAINER_RESET_SPEC);
    logEvent("info", "workspace.reset", { runtimeId: restarted.runtimeId });

    return { ok: true, reset: "workspace" } as const;
  });
}

interface WorkspaceHostEnv {
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

/** A symbolic link or directory at the path is not the managed file; the write refuses rather than follow or replace it. */
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

    if ((yield* lstat(MANAGED_AGENT_INSTRUCTIONS_PATH)) === "directory") {
      return { ok: false, error: { code: "workspace-unavailable" } } as const;
    }

    yield* attemptWorkspace(() =>
      operations.writeFile(MANAGED_AGENT_INSTRUCTIONS_PATH, MANAGED_AGENT_INSTRUCTIONS),
    );

    return { ok: true, result: { kind: "written" } } as const;
  }).pipe(
    answerFailures((thrown): WorkspaceResult => {
      logRedactedCause("workspace.managed-instructions: workspace-unavailable", thrown);

      return { ok: false, error: { code: "workspace-unavailable" } };
    }),
  );
}

/**
 * The one durable Computer workspace a tenant owns. Its RPC surface returns plain values and one
 * narrow project capability, never the workspace, its container API, or a credential-bearing binding.
 */
export class WorkspaceHost extends DurableObject<WorkspaceHostEnv> {
  #workspace: Workspace;
  readonly #containerBackend: CloudflareContainerBackend;
  readonly #workspaceBackend: WorkspaceBackend;
  readonly #container: WorkspaceContainerAPI;
  readonly #idle: WorkspaceIdleController;
  readonly #containerLifecycle = new ContainerLifecycle();
  #resetting = false;

  constructor(ctx: DurableObjectState, env: WorkspaceHostEnv) {
    super(ctx, env);
    const platformContainer = ctx.container;

    this.#container = new WorkspaceContainerAPI(ctx);
    this.#containerBackend = new CloudflareContainerBackend({
      container: () => ({ getWorkspaceContainer: () => this.#container }),
      ...workspaceContainerBackendConfiguration(ctx.id.toString()),
    });
    this.#workspaceBackend = withWorkspaceSyncIgnore(this.#containerBackend, (runtimeId) => {
      this.#containerLifecycle.connected(runtimeId);
      logEvent("info", "workspace.backend.connected", { runtimeId: runtimeId ?? null });
    });
    this.#workspace = this.#newWorkspace();
    this.#idle = new WorkspaceIdleController({
      nowMs: () => Date.now(),
      idleLimitMs: WORKSPACE_IDLE_STOP_MS,
      setAlarm: (atMs) => ctx.storage.setAlarm(atMs),
      containerRunning: () => platformContainer?.running ?? false,
      closeWorkspace: () => this.#workspace.close(),
      stopContainer: async () => {
        await platformContainer?.destroy("idle");
        this.#containerLifecycle.stoppedByHost();
      },
    });
  }

  #tracked<A>(work: () => Effect.Effect<A>): Promise<A> {
    return runAtEntryPoint(trackedWork(this.#idle, Effect.suspend(work)));
  }

  #unlessResetting<A>(refused: A, work: () => Effect.Effect<A>): Promise<A> {
    return this.#resetting ? Promise.resolve(refused) : this.#tracked(work);
  }

  /** A Workspace creates its SQLite tables when constructed, so a wiped store needs a new one. */
  #newWorkspace(): Workspace {
    return new Workspace({
      storage: computerStorage(this.ctx.storage),
      sessionId: this.ctx.id.toString(),
      backends: [this.#workspaceBackend],
    });
  }

  /** A caller names a commit and a step, never command text. A build writes inside no project clone and never inside the editable harness checkout. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Durable Object RPC input is untrusted.
  build(request: unknown): Promise<WorkspaceResult> {
    return this.#unlessResetting(CHANGE_REFUSED, () =>
      executeHarnessBuildRequest({
        configuration: harnessBuildConfiguration(this.env.HARNESS_REPOSITORY_URL),
        operations: new ComputerWorkspaceOperations(this.#workspace, "not-required"),
        request,
      }),
    );
  }

  /** The repository URL and directory come from the catalog, so no caller can point a clone at a URL or place of its own. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Durable Object RPC input is untrusted.
  provision(request: unknown): Promise<WorkspaceResult> {
    return this.#unlessResetting(CHANGE_REFUSED, () =>
      executeProjectProvisionRequest({
        operations: new ComputerWorkspaceOperations(this.#workspace, "require-complete"),
        request,
      }),
    );
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The RPC parser validates this boundary.
  removeProject(request: unknown): Promise<WorkspaceResult> {
    return this.#unlessResetting(CHANGE_REFUSED, () =>
      executeProjectRemovalRequest({
        operations: new ComputerWorkspaceOperations(this.#workspace, "require-complete"),
        request,
      }),
    );
  }

  ensureManagedInstructions(): Promise<WorkspaceResult> {
    return this.#unlessResetting(CHANGE_REFUSED, () =>
      ensureManagedInstructions(new ComputerWorkspaceOperations(this.#workspace, "not-required")),
    );
  }

  /**
   * A token enters the workspace here and stops. The install hands it to `gh` on standard input, so
   * it is in no command line. Install requires a complete sync, because a pending `hosts.yml` would
   * be lost with the container.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Durable Object RPC input is untrusted.
  credential(request: unknown): Promise<GitHubCredentialResult> {
    const work = () =>
      executeGitHubCredentialRequest({
        operations: new ComputerWorkspaceOperations(this.#workspace, "not-required"),
        installOperations: new ComputerWorkspaceOperations(this.#workspace, "require-complete"),
        request,
      });

    return this.#unlessResetting(CREDENTIAL_REFUSED, work);
  }

  /**
   * Tracked work still running would be cut off halfway and could write into the wiped store, so
   * reset refuses while any runs and excludes new work, project capabilities, and a second reset.
   */
  reset(): Promise<WorkspaceResetResult> {
    if (this.#resetting || this.#idle.snapshot().inFlight > 0)
      return Promise.resolve(WORKSPACE_BUSY);

    this.#resetting = true;

    return this.#tracked(() =>
      resetWorkspaceStorage(this.ctx.storage, this.#container).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            // deleteAll dropped the Workspace's own tables; rebuild so the next operation recreates them.
            this.#workspace = this.#newWorkspace();

            // It may also have dropped the idle alarm (the `delete_all_deletes_alarm` flag), so forget
            // the one this instance armed; the end of this call arms a new one.
            this.#idle.forgetAlarm();
          }),
        ),
      ),
    ).finally(() => {
      this.#resetting = false;
    });
  }

  /** During a reset it throws: the Workspace it would wrap is being deleted. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Durable Object RPC input is untrusted.
  project(budget?: unknown): ProjectRpcTarget {
    if (this.#resetting) throw new Error("workspace-busy: the workspace is resetting");

    const remainingMs = parseProjectBudget(budget);
    const options = remainingMs === undefined ? {} : { remainingMs };

    const endLease = this.#idle.lease(Date.now() + (remainingMs ?? PROJECT_TURN_LEASE_MS));

    return new ProjectRpcTarget(
      computerFilesystemProvider(this.#workspace),
      durableObjectTransactions(this.ctx.storage),
      afterIdleStop(
        this.#idle,
        computerExecBackend(this.#workspace, "container-shell", this.#containerLifecycle),
      ),
      { ...options, containerState: this.#containerLifecycle, activity: this.#idle, endLease },
    );
  }

  override fetch(request: Request): Promise<Response> {
    return this.#containerBackend.handleFetch(request);
  }

  /** The RPC WebSocket from computerd is not work, so it never delays a stop. */
  override alarm(): Promise<void> {
    return this.#idle.onAlarm();
  }
}
