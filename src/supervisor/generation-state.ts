import * as Schema from "effect/Schema";
import type { HarnessCommit } from "../harness-commit.js";
import {
  isGenerationLabel,
  type Generation,
  type GenerationLabel,
  type GenerationRecord,
  type GenerationStatus,
} from "./generations.js";

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

export type Selection = Readonly<{ epoch: number; serving: Serving }>;

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
