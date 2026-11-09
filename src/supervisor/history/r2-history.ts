import type { HistoryAppend } from "./log.js";

const HISTORY_PREFIX = "history/";

export function r2History(bucket: R2Bucket): HistoryAppend {
  return async (commit) => {
    await Promise.all(
      Object.entries(commit.files).map(([path, text]) =>
        bucket.put(`${HISTORY_PREFIX}${path}`, text, {
          httpMetadata: { contentType: "application/json" },
        }),
      ),
    );
  };
}
