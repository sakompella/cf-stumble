import type { GenerationLabel } from "./generations.js";

export type RunOutcome = "cancelled" | "interrupted" | "completed" | "failed";

const PROVEN_KEY = "generations.proven";

const PROBATION_KEY = "generations.probation";

export class GenerationProbation {
  readonly #kv: SyncKvStorage;

  constructor(kv: SyncKvStorage) {
    this.#kv = kv;
  }

  activated(label: GenerationLabel): void {
    const proven = this.#kv.get<GenerationLabel>(PROVEN_KEY);

    if (proven === undefined || proven === label) this.#kv.delete(PROBATION_KEY);
    else this.#kv.put(PROBATION_KEY, label);
  }

  settled(label: GenerationLabel, outcome: RunOutcome): GenerationLabel | undefined {
    const onProbation = this.#kv.get<GenerationLabel>(PROBATION_KEY) === label;

    if (outcome === "cancelled") return undefined;

    if (outcome === "completed") this.#kv.put(PROVEN_KEY, label);

    if (onProbation) this.#kv.delete(PROBATION_KEY);

    return onProbation && outcome !== "completed" ? this.#kv.get(PROVEN_KEY) : undefined;
  }
}
