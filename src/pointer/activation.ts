import { assertNever } from "../git/types.js";
import type {
  ActivationEvent,
  ActivationResult,
  GenerationRecord,
} from "../generation/registry-types.js";
import type { GenerationRegistry } from "../generation/registry.js";
import type { GenerationNumber } from "../generation/types.js";

export type ActivationLedgerOptions = {
  readonly registry: GenerationRegistry;
  readonly now?: () => number;
};

export interface ActivationLedger {
  promote(
    generation: GenerationNumber,
    expected: GenerationNumber | undefined,
  ): Promise<ActivationResult>;
  rollback(
    generation: GenerationNumber,
    expected: GenerationNumber | undefined,
  ): Promise<ActivationResult>;
  readPointer(): Promise<GenerationNumber | undefined>;
  readEvents(): Promise<readonly ActivationEvent[]>;
  quarantine(generation: GenerationNumber): Promise<boolean>;
  isQuarantined(generation: GenerationNumber): Promise<boolean>;
}

/**
 * In-memory activation implementation. The pointer check, pointer write, and event append run
 * without an await between them, which gives this adapter one linearizable activation point.
 */
export class MemoryActivationLedger implements ActivationLedger {
  private readonly registry: GenerationRegistry;
  private readonly now: () => number;
  private readonly events: ActivationEvent[] = [];
  private readonly previouslyLive = new Set<GenerationNumber>();
  private readonly quarantined = new Set<GenerationNumber>();
  private pointer: GenerationNumber | undefined;

  constructor(options: ActivationLedgerOptions) {
    this.registry = options.registry;
    this.now = options.now ?? Date.now;
  }

  async promote(
    generation: GenerationNumber,
    expected: GenerationNumber | undefined,
  ): Promise<ActivationResult> {
    const record = await this.registry.get(generation);
    if (record === undefined) {
      return rejected({ kind: "unknown-generation", generation });
    }
    if (this.quarantined.has(generation)) {
      return rejected({ kind: "quarantined", generation });
    }
    if (!isValidated(record)) {
      return rejected({ kind: "not-validated", state: record.state });
    }
    return this.activate("promoted", generation, expected);
  }

  async rollback(
    generation: GenerationNumber,
    expected: GenerationNumber | undefined,
  ): Promise<ActivationResult> {
    const record = await this.registry.get(generation);
    if (record === undefined) {
      return rejected({ kind: "unknown-generation", generation });
    }
    if (this.quarantined.has(generation)) {
      return rejected({ kind: "quarantined", generation });
    }
    if (!this.previouslyLive.has(generation)) {
      return rejected({ kind: "never-promoted", generation });
    }
    return this.activate("rolled_back", generation, expected);
  }

  readPointer(): Promise<GenerationNumber | undefined> {
    return Promise.resolve(this.pointer);
  }

  readEvents(): Promise<readonly ActivationEvent[]> {
    return Promise.resolve(this.events.map((event) => ({ ...event })));
  }

  async quarantine(generation: GenerationNumber): Promise<boolean> {
    if ((await this.registry.get(generation)) === undefined) {
      return false;
    }
    this.quarantined.add(generation);
    return true;
  }

  isQuarantined(generation: GenerationNumber): Promise<boolean> {
    return Promise.resolve(this.quarantined.has(generation));
  }

  private activate(
    kind: ActivationEvent["kind"],
    generation: GenerationNumber,
    expected: GenerationNumber | undefined,
  ): ActivationResult {
    const actual = this.pointer;
    if (actual !== expected) {
      return rejected({ kind: "pointer-moved", expected, actual });
    }

    const event = {
      sequence: this.events.length + 1,
      kind,
      generation,
      from: actual,
      at: this.now(),
    } satisfies ActivationEvent;
    this.pointer = generation;
    this.events.push(event);
    if (actual !== undefined) {
      this.previouslyLive.add(actual);
    }
    this.previouslyLive.add(generation);
    return { outcome: "activated", from: actual, to: generation };
  }
}

export const InMemoryActivationLedger = MemoryActivationLedger;

function isValidated(record: GenerationRecord): boolean {
  switch (record.state) {
    case "validated":
      return true;
    case "loading":
    case "load_failed":
    case "loaded":
    case "validation_failed":
      return false;
    default:
      return assertNever(record.state, "materialization state");
  }
}

function rejected(reason: Extract<ActivationResult, { outcome: "rejected" }>["reason"]): ActivationResult {
  return { outcome: "rejected", reason };
}
