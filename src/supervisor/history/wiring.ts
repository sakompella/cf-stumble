import type { Generations } from "../generations.js";
import { migrateModuleMaps } from "../artifacts/index.js";
import { artifactsHistory } from "./artifacts-repo.js";
import { importGenerations } from "./import.js";
import { GenerationHistory } from "./log.js";

export function generationHistory(
  ctx: DurableObjectState,
  artifacts: Artifacts | undefined,
): GenerationHistory | undefined {
  return artifacts === undefined
    ? undefined
    : new GenerationHistory(
        artifactsHistory(artifacts),
        (pending) => {
          ctx.waitUntil(pending);
        },
        () => Date.now(),
      );
}

export async function migrateStorage(
  ctx: DurableObjectState,
  moduleMaps: R2Bucket,
  history: GenerationHistory | undefined,
  generations: Generations,
): Promise<void> {
  await migrateModuleMaps(ctx.storage.sql, moduleMaps);

  if (history !== undefined) importGenerations(history, generations, ctx.storage.kv);
}
