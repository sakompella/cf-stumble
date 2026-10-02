import { ownerCalls, poller, slowRequests } from "./rules-requests.mts";
import { ranPastIdle, unownedCpu } from "./rules-container.mts";
import { faultEvents } from "./rules-events.mts";
import { missingData } from "./rules-unknown.mts";
import { isoMinute } from "./evidence.mts";
import type { CheckInput, Finding } from "./model.mts";

/**
 * Run every rule over one input. A rule runs only when every source it reads is trustworthy;
 * `missingData` reports the rest, so a skipped rule shows up as `unknown` instead of as silence.
 */
export function runChecks(input: CheckInput): readonly Finding[] {
  const { logs, metrics, instances, window, idleLimitMs } = input;
  const logsUsable = logs.status === "ok";

  // Empty logs cannot attribute container time: absence of owner events there may be absence of data.
  const joinable =
    logs.status === "ok" &&
    !logs.data.truncated &&
    logs.data.events.length + logs.data.invocations.length > 0 &&
    metrics.status === "ok";

  return [
    ...(logsUsable
      ? [
          ...slowRequests(ownerCalls(logs.data, window)),
          ...poller(ownerCalls(logs.data, window)),
          ...faultEvents(logs.data, window),
        ]
      : []),
    ...(joinable
      ? [
          ...unownedCpu(metrics.data.cpu, logs.data, window),
          ...ranPastIdle(
            metrics.data.usage,
            instances.status === "ok" ? instances.data : [],
            logs.data,
            window,
            idleLimitMs,
          ),
        ]
      : []),
    ...missingData(input),
  ];
}

export function windowLabel(input: CheckInput): string {
  return `${isoMinute(input.window.fromMs)}..${isoMinute(input.window.toMs).slice(11)}`;
}

/** One line when all is well; otherwise one line per finding. */
export function formatReport(input: CheckInput, findings: readonly Finding[]): readonly string[] {
  const label = windowLabel(input);

  return findings.length === 0
    ? [`✓ ops-check ${input.worker} ${label}`]
    : findings.map((finding) => {
        const evidence = finding.evidence.length === 0 ? "" : ` [${finding.evidence.join(" ")}]`;

        return `✗ ${finding.rule} ${finding.detail} ${label}${evidence}`;
      });
}
