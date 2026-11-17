import { refusalText, type Refusal } from "./api.js";

export function disconnectRefusal(refusal: Refusal): string {
  return `not disconnected: ${refusalText(refusal)}`;
}

export function disconnectedWording(displayName: string, workspace: "removed" | "failed"): string {
  return workspace === "removed"
    ? `disconnected ${displayName}`
    : `disconnected ${displayName}; its files could not all be removed from the workspace`;
}

export function disconnectPrompt(displayName: string): string {
  return `Disconnect ${displayName}? Uncommitted work in its clone is deleted.`;
}
