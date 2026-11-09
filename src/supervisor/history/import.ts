import type { Generations } from "../generations.js";
import { importCommit } from "./commits.js";
import type { GenerationHistory } from "./log.js";

const IMPORTED_KEY = "generations.history-imported";

export function importGenerations(
  history: GenerationHistory,
  generations: Generations,
  kv: SyncKvStorage,
): void {
  if (kv.get(IMPORTED_KEY) === true) return;

  const records = generations.all();

  const markImported = (): void => {
    kv.put(IMPORTED_KEY, true);
  };

  if (records.length === 0) markImported();
  else history.commit(importCommit(records), markImported);
}
