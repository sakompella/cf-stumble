/**
 * Rules a and b: slow or canceled owner requests, and a route that is polled.
 *
 * Both read the same calls: each `route.settled` event, plus each canceled fetch invocation. A
 * canceled invocation often writes no `route.settled`, and the 09-26 poller was mostly canceled,
 * so the platform record is the only evidence of those calls.
 */
import { eventId, firstIds, invocationId } from "./evidence.mts";
import { busiestHour, rollingHours } from "./intervals.mts";
import { isOwnerRoute, isOwnerWork } from "./ownership.mts";
import {
  POLLER_CALLS_PER_HOUR,
  POLLER_CANCELED_SHARE,
  POLLER_WORKSPACE_TOUCHES,
  SLOW_REQUESTS_PER_HOUR,
  SLOW_REQUEST_MS,
  STREAM_START_SLACK_MS,
} from "./thresholds.mts";
import type { Finding, Invocation, LogData, TimeWindow } from "./model.mts";

export interface OwnerCall {
  readonly atMs: number;
  readonly route: string;
  readonly id: string;
  readonly canceled: boolean;
  readonly slow: boolean;
  readonly touchesWorkspace: boolean;
}

function inWindow(atMs: number, window: TimeWindow): boolean {
  return atMs >= window.fromMs && atMs < window.toMs;
}

function settledCalls(logs: LogData, window: TimeWindow): readonly OwnerCall[] {
  const workspaceRequestIds = new Set(
    logs.events.flatMap((event) =>
      isOwnerWork(event) && event.requestId !== null ? [event.requestId] : [],
    ),
  );

  return logs.events.flatMap((event): OwnerCall[] =>
    event.name === "route.settled" && event.route !== null && inWindow(event.atMs, window)
      ? [
          {
            atMs: event.atMs,
            route: event.route,
            id: eventId(event),
            canceled: false,
            slow: event.spanMs >= SLOW_REQUEST_MS,
            touchesWorkspace: event.requestId !== null && workspaceRequestIds.has(event.requestId),
          },
        ]
      : [],
  );
}

function canceledCalls(logs: LogData, window: TimeWindow): readonly OwnerCall[] {
  const streamStarts = logs.events.filter(
    (event) => event.name === "route.settled" && event.phase === "headers",
  );

  // A streamed turn writes `route.settled` when its stream starts. If the client then leaves, the
  // platform cancels the same invocation; it is one call, so the settled event stands for it.
  const alreadySettled = (invocation: Invocation) =>
    streamStarts.some(
      (event) =>
        event.route === invocation.route &&
        event.atMs >= invocation.atMs - invocation.wallTimeMs - STREAM_START_SLACK_MS &&
        event.atMs <= invocation.atMs,
    );

  return logs.invocations.flatMap((invocation): OwnerCall[] =>
    invocation.outcome === "canceled" &&
    !alreadySettled(invocation) &&
    isOwnerRoute(invocation.route) &&
    inWindow(invocation.atMs, window)
      ? [
          {
            atMs: invocation.atMs,
            route: invocation.route,
            id: invocationId(invocation),
            canceled: true,
            slow: true,
            touchesWorkspace: false,
          },
        ]
      : [],
  );
}

export function ownerCalls(logs: LogData, window: TimeWindow): readonly OwnerCall[] {
  return [...settledCalls(logs, window), ...canceledCalls(logs, window)];
}

function byRoute(calls: readonly OwnerCall[]): ReadonlyMap<string, readonly OwnerCall[]> {
  const routes = new Map<string, OwnerCall[]>();

  for (const call of calls) {
    routes.set(call.route, [...(routes.get(call.route) ?? []), call]);
  }

  return routes;
}

export function slowRequests(calls: readonly OwnerCall[]): readonly Finding[] {
  return [...byRoute(calls.filter((call) => call.slow))].flatMap(([route, slow]): Finding[] => {
    const hour = busiestHour(slow);

    return hour.length >= SLOW_REQUESTS_PER_HOUR
      ? [
          {
            rule: "slow-requests",
            detail: `${hour.length}/h >= ${SLOW_REQUESTS_PER_HOUR}/h slow or canceled on ${route}`,
            evidence: firstIds(hour.map((call) => call.id)),
          },
        ]
      : [];
  });
}

export function poller(calls: readonly OwnerCall[]): readonly Finding[] {
  return [...byRoute(calls)].flatMap(([route, routeCalls]): Finding[] => {
    const hours = rollingHours(routeCalls).filter((hour) => {
      const touches = hour.filter((call) => call.touchesWorkspace).length;
      const canceled = hour.filter((call) => call.canceled).length;

      return (
        hour.length >= POLLER_CALLS_PER_HOUR &&
        (touches >= POLLER_WORKSPACE_TOUCHES || canceled / hour.length > POLLER_CANCELED_SHARE)
      );
    });

    const worst = hours.reduce<readonly OwnerCall[]>(
      (best, hour) => (hour.length > best.length ? hour : best),
      [],
    );

    if (worst.length === 0) {
      return [];
    }

    const touches = worst.filter((call) => call.touchesWorkspace).length;
    const canceled = worst.filter((call) => call.canceled).length;

    return [
      {
        rule: "poller",
        detail: `${worst.length}/h >= ${POLLER_CALLS_PER_HOUR}/h on ${route}, ${touches} touch the workspace, ${canceled} canceled`,
        evidence: firstIds(worst.map((call) => call.id)),
      },
    ];
  });
}
