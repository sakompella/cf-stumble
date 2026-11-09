import type { HistoryAppend } from "./log.js";

const HISTORY_PREFIX = "history/";

export function r2History(bucket: R2Bucket): HistoryAppend {
  return async (commit) => {
    const settled = await Promise.allSettled(
      Object.entries(commit.files).map(([path, text]) =>
        bucket.put(`${HISTORY_PREFIX}${path}`, text, {
          httpMetadata: { contentType: "application/json" },
        }),
      ),
    );

    const refused = settled.find((outcome) => outcome.status === "rejected");

    if (refused !== undefined) throw refused.reason;
  };
}
