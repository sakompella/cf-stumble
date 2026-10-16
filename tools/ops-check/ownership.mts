import { workSpan, type Interval } from "./intervals.mts";
import { STARTUP_GRACE_MS } from "./thresholds.mts";
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
  "harness-build.",
];

/**
 * Events that show an owner request or turn using the container. Container and backend lifecycle
 * events are excluded: they report the container's state, so they cannot explain why it was busy.
 */
export function isOwnerWork(event: AppEvent): boolean {
  return OWNER_WORK_PREFIXES.some((prefix) => event.name.startsWith(prefix));
}

/** Routes the Supervisor decides alone, from its generation tables. They never reach the Host. */
const SUPERVISOR_ONLY_ROUTES: ReadonlySet<string> = new Set([
  "/api/generations/activate",
  "/api/generations/rollback",
]);

/**
 * A `route.settled` that may have kept the Host busy. A refused request stopped before any work,
 * and activation and rollback never reach the Host, so neither one resets its idle clock.
 */
function settledReachesHost(event: AppEvent): boolean {
  return (
    event.name === "route.settled" &&
    event.applicationOutcome !== "refused" &&
    !(event.route !== null && SUPERVISOR_ONLY_ROUTES.has(event.route))
  );
}

/** Any event an owner caused that can hold the Host: owner work, or an accepted request on a Host route. */
export function isOwnerActivity(event: AppEvent): boolean {
  return settledReachesHost(event) || isOwnerWork(event);
}

/** Routes the owner API serves. Other paths (assets, the page) never touch the workspace. */
export function isOwnerRoute(route: string): boolean {
  return route.startsWith("/api/");
}

/**
 * The span the container is explained by work: each owner event's work, plus the startup grace
 * after a launch. A launch is the one lifecycle event that explains time, because a cold start
 * and its first status read run before any request logs. No other lifecycle event owns time.
 */
export function workSpans(events: readonly AppEvent[]): readonly Interval[] {
  return events.flatMap((event): Interval[] => {
    if (event.name === "workspace.container.started") {
      return [{ beginMs: event.atMs, endMs: event.atMs + STARTUP_GRACE_MS }];
    }

    return isOwnerWork(event) ? [workSpan(event)] : [];
  });
}

/** `workSpans` plus accepted requests that settled without touching the workspace. */
export function activitySpans(events: readonly AppEvent[]): readonly Interval[] {
  return [
    ...workSpans(events),
    ...events.flatMap((event): Interval[] => (settledReachesHost(event) ? [workSpan(event)] : [])),
  ];
}
