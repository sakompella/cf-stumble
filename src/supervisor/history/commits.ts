import type { GenerationActor, GenerationRecord } from "../generations.js";

export type GenerationChange = Readonly<{
  kind: "submitted" | "prepared" | "activated" | "rolled-back" | "probation-failed" | "proven";
  actor: GenerationActor;
  epoch: number;
  outcome: string | null;
  errorCode: string | null;
  record: GenerationRecord;
}>;

export type HistoryCommit = Readonly<{
  message: string;
  files: Readonly<Record<string, string>>;
}>;

function generationFile(record: GenerationRecord): readonly [string, string] {
  const { generation, wasActive, compatibility } = record;

  const body = {
    label: generation.label,
    harnessCommit: generation.harnessCommit,
    status: generation.status,
    wasActive,
    facetCompatibility: compatibility ?? null,
  };

  return [`generations/${generation.label}.json`, JSON.stringify(body, null, 2)];
}

export function changeCommit(change: GenerationChange, time: number): HistoryCommit {
  const { label } = change.record.generation;

  const event = {
    kind: change.kind,
    actor: change.actor,
    label,
    epoch: change.epoch,
    time: new Date(time).toISOString(),
    outcome: change.outcome,
    errorCode: change.errorCode,
  };

  return {
    message: `${change.kind} generation ${label}`,
    files: {
      ...Object.fromEntries([generationFile(change.record)]),
      [`events/${change.epoch}-${change.kind}.json`]: JSON.stringify(event, null, 2),
    },
  };
}
