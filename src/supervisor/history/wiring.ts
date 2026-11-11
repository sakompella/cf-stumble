import { GenerationHistory } from "./log.js";
import { r2History } from "./r2-history.js";

export function generationHistory(ctx: DurableObjectState, bucket: R2Bucket): GenerationHistory {
  return new GenerationHistory(
    r2History(bucket),
    (pending) => {
      ctx.waitUntil(pending);
    },
    () => Date.now(),
  );
}
