import { vi } from "vitest";
import { FACET_COMPATIBILITY } from "../../../src/facet/runtime-contract.js";
import { Generations } from "../../../src/supervisor/generations.js";
import type {
  GenerationChange,
  GenerationLabel,
} from "../../../src/supervisor/generation-state.js";
import { testHarnessCommit } from "../../harness-commit-fixtures.js";

const READY = { status: "ready", compatibility: FACET_COMPATIBILITY } as const;

export function spyPorts() {
  return {
    changed: vi.fn<(change: GenerationChange) => void>(),
    facetReplaced: vi.fn<() => void>(),
  };
}

export function generationsOf(
  storage: DurableObjectStorage,
  compatibility: string = FACET_COMPATIBILITY,
): Generations {
  return new Generations(storage, compatibility, spyPorts());
}

export function served(generations: Generations, digit: string): GenerationLabel {
  const { label } = generations.submit(testHarnessCommit(digit.repeat(40)), "owner").generation;
  generations.recordPreparation(label, READY, "owner");
  const observedEpoch = generations.active().epoch;
  generations.activate({ kind: "activate", label, observedEpoch }, "owner");

  return label;
}
