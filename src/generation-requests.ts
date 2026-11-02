import * as Schema from "effect/Schema";
import { isHarnessCommit, type HarnessCommit } from "./harness-commit.js";
import {
  isGenerationLabel,
  type ActivationCommand,
  type ActiveGeneration,
  type Generation,
  type GenerationControlResult,
  type GenerationLabel,
  type Submission,
} from "./supervisor/generations.js";
import type { StartupCheckResult } from "./supervisor/startup-check/index.js";

export type { ActiveGeneration };

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const GenerationSubmissionRequest = Schema.Struct({
  harnessCommit: Schema.String.pipe(Schema.refine(isHarnessCommit)),
});

export const GenerationControlTarget = Schema.Struct({
  observedEpoch: Count,
  label: Count.pipe(Schema.refine(isGenerationLabel)),
});

export const GenerationControlRequest = Schema.Struct({
  kind: Schema.Literals(["activate", "rollback"]),
  ...GenerationControlTarget.fields,
});

export type GenerationStatusView = Readonly<{ generation: Generation | null; epoch: number }>;

export function generationStatusView(active: ActiveGeneration): GenerationStatusView {
  return { generation: active.generation ?? null, epoch: active.epoch };
}

type Answer<T> = T | Promise<T>;

export type GenerationOperations = Readonly<{
  getActiveGeneration(): Answer<ActiveGeneration>;
  submitGeneration(harnessCommit: HarnessCommit): Answer<Submission>;
  prepareGeneration(label: GenerationLabel): Promise<StartupCheckResult>;
  controlGeneration(command: ActivationCommand): Answer<GenerationControlResult>;
}>;

type GenerationControlCommand = Readonly<{
  kind: "activate" | "rollback";
  label: number;
  observedEpoch: number;
}>;

export interface GenerationControl {
  generationStatus(): Promise<GenerationStatusView>;
  submitGeneration(harnessCommit: string): Promise<Submission>;
  prepareGeneration(label: number): Promise<StartupCheckResult>;
  controlGeneration(command: GenerationControlCommand): Promise<GenerationControlResult>;
}
