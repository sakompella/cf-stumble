import type { DisconnectProblemCode } from "../../api/problems.js";
import { refusalText, type Refusal } from "./api.js";

const DISCONNECT_REFUSALS = {
  "invalid-project-id": "this project id is not valid",
  "unknown-project-id": "this project is not connected any more",
  "run-active": "a run is active in this project; cancel it first",
  "workspace-busy": "the workspace is busy; try again when it has finished",
} as const satisfies Record<DisconnectProblemCode, string>;

function isDisconnectProblem(code: string): code is DisconnectProblemCode {
  return Object.hasOwn(DISCONNECT_REFUSALS, code);
}

export function disconnectRefusal(refusal: Refusal): string {
  return refusal.kind === "problem" && isDisconnectProblem(refusal.code)
    ? `not disconnected: ${DISCONNECT_REFUSALS[refusal.code]}`
    : `not disconnected: ${refusalText(refusal)}`;
}

export function disconnectedWording(displayName: string, workspace: "removed" | "failed"): string {
  return workspace === "removed"
    ? `disconnected ${displayName}`
    : `disconnected ${displayName}; its files could not all be removed from the workspace`;
}

export function disconnectPrompt(displayName: string): string {
  return `Disconnect ${displayName}? Uncommitted work in its clone is deleted.`;
}
