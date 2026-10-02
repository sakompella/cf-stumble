/**
 * Rule f: report what could not be checked.
 *
 * A source that failed, returned nothing while another showed activity, or hit its row limit is
 * `unknown`. It is never read as zero, because a quiet answer from a broken source would hide the
 * incident the check exists to find.
 */
import type { CheckInput, Finding } from "./model.mts";

function unknown(detail: string): Finding {
  return { rule: "unknown", detail, evidence: [] };
}

export function missingData(input: CheckInput): readonly Finding[] {
  const { logs, metrics } = input;

  if (logs.status === "unavailable" || metrics.status === "unavailable") {
    return [
      ...(logs.status === "unavailable" ? [unknown(`logs unavailable: ${logs.reason}`)] : []),
      ...(metrics.status === "unavailable"
        ? [unknown(`metrics unavailable: ${metrics.reason}`)]
        : []),
    ];
  }

  const logRows = logs.data.events.length + logs.data.invocations.length;
  const { cpu, usage } = metrics.data;

  return [
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
