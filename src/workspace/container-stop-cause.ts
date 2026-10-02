import type { LogLevel } from "../diagnostics.js";
import { containerExitCode, type ContainerReasonCode } from "./backend-sync-ignore.js";

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
