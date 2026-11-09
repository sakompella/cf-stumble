import { logRedactedCause, logEvent } from "../../diagnostics.js";
import { changeCommit, type GenerationChange, type HistoryCommit } from "./commits.js";

export type HistoryAppend = (commit: HistoryCommit) => Promise<void>;

export class GenerationHistory {
  readonly #append: HistoryAppend;
  readonly #keepAlive: (pending: Promise<void>) => void;
  readonly #clock: () => number;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    append: HistoryAppend,
    keepAlive: (pending: Promise<void>) => void,
    clock: () => number,
  ) {
    this.#append = append;
    this.#keepAlive = keepAlive;
    this.#clock = clock;
  }

  record(change: GenerationChange): void {
    this.commit(changeCommit(change, this.#clock()));
  }

  commit(commit: HistoryCommit, written?: () => void): void {
    const pending = this.#tail.then(() =>
      this.#append(commit).then(written, (cause: unknown) => {
        logEvent("warn", "generation.history-failed", { message: commit.message });
        logRedactedCause("generation-history.append", cause);
      }),
    );

    this.#tail = pending;
    this.#keepAlive(pending);
  }
}
