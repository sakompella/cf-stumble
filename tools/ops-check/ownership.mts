import type { AppEvent } from "./model.mts";

const OWNER_WORK_PREFIXES = [
  "turn.",
  "workspace.rpc",
  "workspace.exec",
  "workspace.command",
  "workspace.provision",
  "workspace.clone",
  "workspace.reset",
  "github-credential.",
];

/**
 * Events that show an owner request or turn using the container. Container and backend lifecycle
 * events are excluded: they report the container's state, so they cannot explain why it was busy.
 */
export function isOwnerWork(event: AppEvent): boolean {
  return OWNER_WORK_PREFIXES.some((prefix) => event.name.startsWith(prefix));
}

/** Any event an owner caused, including `route.settled` that touches no workspace work. */
export function isOwnerActivity(event: AppEvent): boolean {
  return event.name === "route.settled" || isOwnerWork(event);
}

/** Routes the owner API serves. Other paths (assets, the page) never touch the workspace. */
export function isOwnerRoute(route: string): boolean {
  return route.startsWith("/api/");
}
