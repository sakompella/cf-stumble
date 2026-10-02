/** Rule e: events that name a fault outright. Each needs a human, so each has threshold zero. */
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
      events.filter((event) => event.name === "workspace.backend.closed" && event.running === true),
    ),
    ...finding(
      "unexplained-stop",
      "workspace.container.stopped with reasonCode unknown at warn or error",
      events.filter(
        (event) =>
          event.name === "workspace.container.stopped" &&
          event.reasonCode === "unknown" &&
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
