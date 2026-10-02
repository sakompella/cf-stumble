/**
 * Rule e: events that name a fault outright. Each needs a human, so each has threshold zero.
 *
 * `unexplained-stop` keys on `reasonSource`, because the Host sets it to `unknown` for any exit it
 * did not cause. That includes the platform stopping an idle container, so a finding here can be
 * an ordinary idle stop; read `reasonCode` and the surrounding events before acting.
 */
import { RESTART_CLOSE_WINDOW_MS } from "./thresholds.mts";
import { eventId, firstIds } from "./evidence.mts";
import type { AppEvent, Finding, LogData, RuleId, TimeWindow } from "./model.mts";

function finding(rule: RuleId, what: string, matches: readonly AppEvent[]): readonly Finding[] {
  return matches.length === 0
    ? []
    : [
        {
          rule,
          detail: `${matches.length} > 0 ${what}`,
          evidence: firstIds(matches.map((event) => eventId(event))),
        },
      ];
}

/**
 * A reset or a recovery restarts the container on purpose, and the backend transport closes while
 * it does. Such a close is not a fault, so a close within seconds of the Host's own stop or wake
 * request is not reported.
 */
function nearRestart(close: AppEvent, events: readonly AppEvent[]): boolean {
  return events.some(
    (event) =>
      (event.name === "workspace.container.stop-requested" ||
        event.name === "workspace.container.wake-requested") &&
      Math.abs(event.atMs - close.atMs) <= RESTART_CLOSE_WINDOW_MS,
  );
}

export function faultEvents(logs: LogData, window: TimeWindow): readonly Finding[] {
  const events = logs.events.filter(
    (event) => event.atMs >= window.fromMs && event.atMs < window.toMs,
  );

  const errorNames = [
    ...new Set(events.filter((event) => event.level === "error").map((e) => e.name)),
  ];

  return [
    ...finding(
      "running-close",
      "workspace.backend.closed with running true",
      events.filter(
        (event) =>
          event.name === "workspace.backend.closed" &&
          event.running === true &&
          event.trigger !== "idle-stop" &&
          !nearRestart(event, events),
      ),
    ),
    ...finding(
      "unexplained-stop",
      "workspace.container.stopped with an unknown reasonSource at warn or error",
      events.filter(
        (event) =>
          event.name === "workspace.container.stopped" &&
          event.reasonSource === "unknown" &&
          event.reasonCode !== "placement-unavailable" &&
          (event.level === "warn" || event.level === "error"),
      ),
    ),
    ...finding(
      "placement-unavailable",
      "workspace.container.stopped with placement-unavailable (the platform had no machine to start on)",
      events.filter(
        (event) =>
          event.name === "workspace.container.stopped" &&
          event.reasonCode === "placement-unavailable" &&
          (event.level === "warn" || event.level === "error"),
      ),
    ),
    ...errorNames.flatMap((name) =>
      finding(
        "error-events",
        `${name} at error level`,
        events.filter((event) => event.level === "error" && event.name === name),
      ),
    ),
  ];
}
