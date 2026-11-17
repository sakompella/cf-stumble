import * as Schema from "effect/Schema";
import type { ControlProblemCode } from "../api/problems.js";
import type { HarnessCommit } from "../harness-commit.js";

export type GenerationStatus = "candidate" | "ready" | "failed";

export type GenerationActor = "owner" | "conversation" | "probation";

declare const generationLabelBrand: unique symbol;

export type GenerationLabel = number & {
  readonly [generationLabelBrand]: "GenerationLabel";
};

export function isGenerationLabel(value: number): value is GenerationLabel {
  return Number.isSafeInteger(value) && value >= 0;
}

export type Generation = Readonly<{
  label: GenerationLabel;
  harnessCommit: HarnessCommit;
  status: GenerationStatus;
}>;

export type GenerationRecord = Readonly<{
  generation: Generation;
  wasActive: boolean;
  compatibility: string | undefined;
}>;

export type GenerationChange = Readonly<{
  kind: "submitted" | "prepared" | "activated" | "rolled-back" | "probation-failed" | "proven";
  actor: GenerationActor;
  epoch: number;
  outcome: string | null;
  errorCode: string | null;
  record: GenerationRecord;
}>;

export type ActiveGeneration = Readonly<{
  generation: Generation | undefined;
  epoch: number;
}>;

export type ActivationCommand = Readonly<{
  kind: "activate" | "rollback";
  label: GenerationLabel;
  observedEpoch: number;
}>;

export type Submission = Readonly<{
  kind: "candidate-submitted";
  generation: Generation;
  epoch: number;
}>;

export type GenerationControlResult =
  | Readonly<{
      ok: true;
      outcome: Readonly<{
        kind: "activated" | "rolled-back";
        generation: Generation;
        epoch: number;
        effect: "activated" | "no-op";
        droppedCommit?: HarnessCommit;
      }>;
    }>
  | Readonly<{ ok: false; problem: Readonly<{ code: ControlProblemCode }> }>;

export type PreparationOutcome =
  | Readonly<{ status: "ready"; compatibility: string }>
  | Readonly<{ status: "failed" }>;

const Label = Schema.Number.pipe(Schema.refine(isGenerationLabel));

export const GenerationState = Schema.TaggedUnion({
  Candidate: {},
  Failed: {},
  Ready: { compatibility: Schema.String },
  Served: { compatibility: Schema.String },
});

export type GenerationState = typeof GenerationState.Type;

export const Serving = Schema.TaggedUnion({
  Unproven: { active: Schema.NullOr(Label) },
  Proven: { active: Label },
  Probation: { active: Label, fallback: Label },
});

export type Serving = typeof Serving.Type;

export type LabeledGeneration = Readonly<{
  label: GenerationLabel;
  harnessCommit: HarnessCommit;
  state: GenerationState;
}>;

export type Selection = Readonly<{ epoch: number; instance: number; serving: Serving }>;

const WIRE_STATUS: Readonly<Record<GenerationState["_tag"], GenerationStatus>> = {
  Candidate: "candidate",
  Failed: "failed",
  Ready: "ready",
  Served: "ready",
};

export function wireGeneration(entry: LabeledGeneration): Generation {
  return {
    label: entry.label,
    harnessCommit: entry.harnessCommit,
    status: WIRE_STATUS[entry.state._tag],
  };
}

export function wireRecord(entry: LabeledGeneration): GenerationRecord {
  const generation = wireGeneration(entry);

  return GenerationState.match(entry.state, {
    Candidate: () => ({ generation, wasActive: false, compatibility: undefined }),
    Failed: () => ({ generation, wasActive: false, compatibility: undefined }),
    Ready: ({ compatibility }) => ({ generation, wasActive: false, compatibility }),
    Served: ({ compatibility }) => ({ generation, wasActive: true, compatibility }),
  });
}
