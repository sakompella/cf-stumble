import type { IWorkspaceContainerAPI } from "@cloudflare/computer/backends/container";
import { logEvent, type LogLevel } from "../diagnostics.js";

export type WorkspaceContainerStatus = Awaited<ReturnType<IWorkspaceContainerAPI["status"]>>;

export function containerStatusIndicatesReplacement(status: WorkspaceContainerStatus): boolean {
  return !status.running || status.exit !== null;
}

type ContainerReasonCode =
  | "not-reported"
  | "unexpected-exit-code"
  | "normal-exit"
  | "connection-lost"
  | "placement-unavailable"
  | "idle-stop"
  | "unknown"
  | "status-unavailable";

export function containerReasonCode(reason: string | undefined): ContainerReasonCode {
  if (reason === undefined) return "not-reported";

  if (/unexpected exit code/iu.test(reason)) return "unexpected-exit-code";

  if (/normally/iu.test(reason)) return "normal-exit";

  if (/network|connection/iu.test(reason)) return "connection-lost";

  // `monitor()` rejects this way when the platform has no machine for the container, which is a
  // placement failure and not a stop. Computer retries the connect after it.
  if (/no container instance that can be provided/iu.test(reason)) return "placement-unavailable";

  return "unknown";
}

function containerExitCode(reason: string | undefined): number | null {
  const match = /exit code[=: ]+(\d+)/iu.exec(reason ?? "");

  return match === null ? null : Number(match[1]);
}

/** One status read: what it returned, or that it failed. */
type ContainerStatusRead =
  | { readonly read: "ok"; readonly status: WorkspaceContainerStatus }
  | { readonly read: "failed" };

/**
 * Why the backend stopped being usable: its transport closed, a connect attempt failed, or the
 * Host closed it to stop an idle container (`idle-stop`, an ordinary info event).
 */
export type BackendCloseTrigger = "transport-closed" | "connect-failed" | "idle-stop";

/** Read the status once; a rejection becomes `{ read: "failed" }`. */
export async function readContainerStatus(
  container: Readonly<{ status(): Promise<WorkspaceContainerStatus> }>,
): Promise<ContainerStatusRead> {
  try {
    return { read: "ok", status: await container.status() };
  } catch {
    return { read: "failed" };
  }
}

function closeLevel(trigger: BackendCloseTrigger): "info" | "warn" {
  return trigger === "idle-stop" ? "info" : "warn";
}

/**
 * Record that a backend closed or failed to connect, with what one status read saw. This is not a
 * stopped container, so `running` is `null` when the read failed. It writes one event.
 */
export function recordWorkspaceBackendClosed(
  trigger: BackendCloseTrigger,
  result: ContainerStatusRead,
): void {
  if (result.read === "failed") {
    const reasonCode: ContainerReasonCode = "status-unavailable";
    logEvent(closeLevel(trigger), "workspace.backend.closed", {
      trigger,
      running: null,
      reasonCode,
      exitCode: null,
      statusReadOutcome: "failed",
    });

    return;
  }

  const { status } = result;
  const reason = status.exit?.reason;
  logEvent(closeLevel(trigger), "workspace.backend.closed", {
    trigger,
    running: status.running,
    reasonCode: containerReasonCode(reason),
    exitCode: containerExitCode(reason),
    statusReadOutcome: "ok",
  });
}

/**
 * Read the container status once after a backend closed, and decide from that one read. A
 * replacement bumps the caller's generation, and the same read is what the log reports, so the two
 * cannot disagree. A failed read proves nothing, so it bumps nothing.
 */
export async function observeBackendClose(
  container: Readonly<{ status(): Promise<WorkspaceContainerStatus> }>,
  trigger: BackendCloseTrigger,
  onReplaced: () => void,
): Promise<void> {
  const result = await readContainerStatus(container);

  if (result.read === "ok" && containerStatusIndicatesReplacement(result.status)) onReplaced();

  recordWorkspaceBackendClosed(trigger, result);
}

/** What the platform monitor said about an exit: text for the reason code, and a code if it gave one. */
export type StopCause = Readonly<{ reason: string; exitCode: number | null }>;

export const NORMAL_STOP: StopCause = { reason: "exited normally", exitCode: null };

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- A platform error may carry an exitCode; nothing else is read.
function reportedExitCode(error: unknown): number | null {
  if (!(error instanceof Error) || !("exitCode" in error)) return null;

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: the property is unchecked platform data.
  return typeof error.exitCode === "number" ? error.exitCode : null;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- A monitor rejection can be anything; this reads only a message and a code.
export function stopCause(error: unknown): StopCause {
  const reason = error instanceof Error ? error.message : String(error);

  return { reason, exitCode: reportedExitCode(error) ?? containerExitCode(reason) };
}

/** A clean exit is ordinary, a crash code is a fault, and anything else the Host did not cause is a warning. */
export function stopLevel(reasonCode: ContainerReasonCode, intentional: boolean): LogLevel {
  if (intentional || reasonCode === "normal-exit") return "info";

  return reasonCode === "unexpected-exit-code" ? "error" : "warn";
}
