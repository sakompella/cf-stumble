import type { Generations } from "../generations.js";
import { migrateModuleMaps } from "../artifacts/index.js";
import { importGenerations } from "./import.js";
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

export async function migrateStorage(
  ctx: DurableObjectState,
  moduleMaps: R2Bucket,
  history: GenerationHistory,
  generations: Generations,
): Promise<void> {
  await migrateModuleMaps(ctx.storage.sql, moduleMaps);

  importGenerations(history, generations, ctx.storage.kv);
}
