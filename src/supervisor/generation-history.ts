import { logEvent, logRedactedCause } from "../diagnostics.js";
import type { GenerationChange, GenerationRecord } from "./generation-state.js";

const HISTORY_PREFIX = "history/";

function recordBody(record: GenerationRecord): string {
  const { generation, wasActive, compatibility } = record;

  return JSON.stringify(
    {
      label: generation.label,
      harnessCommit: generation.harnessCommit,
      status: generation.status,
      wasActive,
      facetCompatibility: compatibility ?? null,
    },
    null,
    2,
  );
}

function eventBody(change: GenerationChange, time: number): string {
  return JSON.stringify(
    {
      kind: change.kind,
      actor: change.actor,
      label: change.record.generation.label,
      epoch: change.epoch,
      time: new Date(time).toISOString(),
      outcome: change.outcome,
      errorCode: change.errorCode,
    },
    null,
    2,
  );
}

export class GenerationHistory {
  readonly #bucket: R2Bucket;
  readonly #keepAlive: (pending: Promise<void>) => void;
  readonly #clock: () => number;
  #tail: Promise<void> = Promise.resolve();

  constructor(bucket: R2Bucket, keepAlive: (pending: Promise<void>) => void, clock: () => number) {
    this.#bucket = bucket;
    this.#keepAlive = keepAlive;
    this.#clock = clock;
  }

  record(change: GenerationChange): void {
    const time = this.#clock();
    const pending = this.#tail.then(() => this.#write(change, time));

    this.#tail = pending;
    this.#keepAlive(pending);
  }

  async #write(change: GenerationChange, time: number): Promise<void> {
    const { kind, epoch, record } = change;
    const label = record.generation.label;

    const files = [
      [`generations/${label}.json`, recordBody(record)],
      [`events/${epoch}-${kind}.json`, eventBody(change, time)],
    ] as const;

    const settled = await Promise.allSettled(
      files.map(([path, text]) =>
        this.#bucket.put(`${HISTORY_PREFIX}${path}`, text, {
          httpMetadata: { contentType: "application/json" },
        }),
      ),
    );

    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        logEvent("warn", "generation.history-failed", { kind, label, epoch });
        logRedactedCause("generation-history.append", outcome.reason);
      }
    }
  }
}
