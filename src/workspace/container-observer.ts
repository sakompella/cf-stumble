import type {
  ContainerLaunchSpec,
  ContainerRuntimeInfo,
  IWorkspaceContainerAPI,
} from "@cloudflare/computer/backends/container";
import { logEvent } from "../diagnostics.js";

/** Why the Workspace Host asked the container to launch. */
export type ContainerWakeTrigger = "backend-connect" | "backend-recovery" | "workspace-reset";

/**
 * The container API the backend and the Host use, with each launch logged. It delegates every call
 * unchanged. It reads `status()` once per launch, which reads a flag and wakes nothing, and it adds
 * no timer, heartbeat, or poll.
 *
 * `start` is the backend's first connect. It adopts a running container or launches one. `restart`
 * is the backend's one recovery after a failed health probe. `restartFor` is the Host's own
 * restart, such as a reset. Only a launch that Computer reports is logged as started: the outcome
 * comes from its return value, and a call that throws writes no started event.
 *
 * `attempt` counts the launch requests this Workspace Host instance has seen since it was built. A
 * new instance starts again at 1.
 */
export class ObservedWorkspaceContainer implements IWorkspaceContainerAPI {
  readonly #inner: IWorkspaceContainerAPI;
  #attempts = 0;

  constructor(inner: IWorkspaceContainerAPI) {
    this.#inner = inner;
  }

  start(spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    return this.#launch("backend-connect", spec, (next) => this.#inner.start(next));
  }

  restart(spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    return this.restartFor("backend-recovery", spec);
  }

  restartFor(
    trigger: ContainerWakeTrigger,
    spec: ContainerLaunchSpec,
  ): Promise<ContainerRuntimeInfo> {
    return this.#launch(trigger, spec, (next) => this.#inner.restart(next));
  }

  async #launch(
    trigger: ContainerWakeTrigger,
    spec: ContainerLaunchSpec,
    run: (spec: ContainerLaunchSpec) => Promise<ContainerRuntimeInfo>,
  ): Promise<ContainerRuntimeInfo> {
    this.#attempts += 1;
    const attempt = this.#attempts;
    const runningBefore = await this.#runningBefore();

    // A first connect that finds the container running may only adopt it, so it is not a wake.
    if (trigger !== "backend-connect" || runningBefore !== true) {
      logEvent("info", "workspace.container.wake-requested", { trigger, runningBefore, attempt });
    }

    const startedAt = Date.now();
    const runtime = await run(spec);
    const adopted = runtime.outcome === "adopted";

    logEvent("info", adopted ? "workspace.container.adopted" : "workspace.container.started", {
      trigger,
      runningBefore,
      attempt,
      outcome: runtime.outcome,
      runtimeId: runtime.runtimeId,
      startedAtMs: adopted ? null : Date.now(),
      durationMs: Date.now() - startedAt,
    });

    return runtime;
  }

  async #runningBefore(): Promise<boolean | null> {
    try {
      return (await this.#inner.status()).running;
    } catch {
      return null;
    }
  }

  setInactivityTimeout(durationMs: number): Promise<void> {
    return this.#inner.setInactivityTimeout(durationMs);
  }

  status(): ReturnType<IWorkspaceContainerAPI["status"]> {
    return this.#inner.status();
  }

  exitInfo(): ReturnType<IWorkspaceContainerAPI["exitInfo"]> {
    return this.#inner.exitInfo();
  }

  interceptOutboundHttp(...args: Parameters<IWorkspaceContainerAPI["interceptOutboundHttp"]>) {
    return this.#inner.interceptOutboundHttp(...args);
  }

  interceptAllOutboundHttp(
    ...args: Parameters<IWorkspaceContainerAPI["interceptAllOutboundHttp"]>
  ) {
    return this.#inner.interceptAllOutboundHttp(...args);
  }

  fetchPort(...args: Parameters<IWorkspaceContainerAPI["fetchPort"]>) {
    return this.#inner.fetchPort(...args);
  }

  port(...args: Parameters<IWorkspaceContainerAPI["port"]>) {
    return this.#inner.port(...args);
  }
}
