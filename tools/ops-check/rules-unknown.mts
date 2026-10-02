/**
 * Rule f: report what could not be checked.
 *
 * A source that failed, returned nothing while another showed activity, or hit its row limit is
 * `unknown`. It is never read as zero, because a quiet answer from a broken source would hide the
 * incident the check exists to find.
 */
import { horizonOf } from "./horizon.mts";
import { MINUTE_MS, type CheckInput, type Finding } from "./model.mts";
import { UNOWNED_RUN_MS } from "./thresholds.mts";

function unknown(detail: string): Finding {
  return { rule: "unknown", detail, evidence: [] };
}

/**
 * `unknown` for a source that returned nothing while another source shows activity. When every
 * source is empty and no instance runs, nothing is known to have happened, and the check passes:
 * a quiet system looks exactly like this, and a check that failed on it could never be green.
 */
function emptyWhileActive(
  name: string,
  rows: number,
  others: readonly (readonly [string, number])[],
): readonly Finding[] {
  const active = others.filter(([, count]) => count > 0);

  return rows > 0 || active.length === 0
    ? []
    : [
        unknown(
          `${name} empty while ${active.map(([what, count]) => `${count} ${what}`).join(", ")} show activity`,
        ),
      ];
}

export function missingData(input: CheckInput): readonly Finding[] {
  const { logs, metrics, instances } = input;

  // Instances describe the present, so a failure matters only to a window that reaches it.
  const instancesUnknown =
    instances.status === "unavailable" && horizonOf(input).live
      ? [unknown(`instances unavailable: ${instances.reason}`)]
      : [];

  if (logs.status === "unavailable" || metrics.status === "unavailable") {
    return [
      ...(logs.status === "unavailable" ? [unknown(`logs unavailable: ${logs.reason}`)] : []),
      ...(metrics.status === "unavailable"
        ? [unknown(`metrics unavailable: ${metrics.reason}`)]
        : []),
      ...instancesUnknown,
    ];
  }

  const logRows = logs.data.events.length + logs.data.invocations.length;
  const { cpu, usage } = metrics.data;
  const runningNow = horizonOf(input).live && instances.status === "ok" ? instances.data.length : 0;

  const completeMs = horizonOf(input).completeUntilMs - input.window.fromMs;

  const shortWindow =
    completeMs < UNOWNED_RUN_MS
      ? [
          unknown(
            `window has ${Math.max(0, Math.floor(completeMs / MINUTE_MS))} min of complete metrics; unowned-cpu needs ${UNOWNED_RUN_MS / MINUTE_MS}`,
          ),
        ]
      : [];

  return [
    ...instancesUnknown,
    ...shortWindow,
    ...(logs.data.truncated ? [unknown("logs truncated at the query row limit")] : []),
    ...emptyWhileActive("logs", logRows, [
      ["metrics buckets", cpu.length + usage.length],
      ["running instances", runningNow],
    ]),
    ...emptyWhileActive("cpu metrics", cpu.length, [
      ["log rows", logRows],
      ["usage buckets", usage.length],
      ["running instances", runningNow],
    ]),
    ...emptyWhileActive("usage metrics", usage.length, [
      ["log rows", logRows],
      ["cpu buckets", cpu.length],
      ["running instances", runningNow],
    ]),
  ];
}
