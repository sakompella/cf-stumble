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
    ...(logRows > 0 && cpu.length === 0
      ? [unknown(`cpu metrics empty while logs show ${logRows} rows`)]
      : []),
    ...(logRows > 0 && usage.length === 0
      ? [unknown(`usage metrics empty while logs show ${logRows} rows`)]
      : []),
    ...(logRows === 0 && cpu.length + usage.length > 0
      ? [
          unknown(
            `logs empty while metrics show ${cpu.length + usage.length} buckets, so container time cannot be attributed`,
          ),
        ]
      : []),
  ];
}
