import * as Schema from "effect/Schema";
import { defineTaggedUnion } from "foldkit/schema";

export const FreshThread = defineTaggedUnion({
  Idle: {},
  Armed: {},
  Starting: {},
  Told: { wording: Schema.String },
});

export type FreshThread = typeof FreshThread.Type;

export const Ground = defineTaggedUnion({
  NoProject: {},
  RunActive: {},
  Ready: { projectId: Schema.String, streamId: Schema.Number },
});

export type Ground = typeof Ground.Type;

export const FreshThreadEvent = defineTaggedUnion({
  Clicked: { ground: Ground },
  Sent: {},
  SelectedProject: {},
  Succeeded: {},
  Refused: { wording: Schema.String },
  Failed: {},
});

export type FreshThreadEvent = typeof FreshThreadEvent.Type;

type ReplaceThreadRequest = Readonly<{ projectId: string; streamId: number }>;

export type FreshThreadStep = Readonly<{
  phase: FreshThread;
  maybeReplace: ReplaceThreadRequest | undefined;
}>;

const stay = (phase: FreshThread): FreshThreadStep => ({ phase, maybeReplace: undefined });

const told = (wording: string): FreshThreadStep => stay(FreshThread.Told({ wording }));

function clicked(phase: FreshThread, ground: Ground): FreshThreadStep {
  return FreshThread.match<FreshThreadStep>(phase, {
    Starting: () => stay(phase),
    Armed: () =>
      Ground.match<FreshThreadStep>(ground, {
        NoProject: () => told("select a project first"),
        RunActive: () => told("a run is active; cancel it first"),
        Ready: (ready) => ({
          phase: FreshThread.Starting(),
          maybeReplace: { projectId: ready.projectId, streamId: ready.streamId },
        }),
      }),
    Idle: () => arm(ground),
    Told: () => arm(ground),
  });
}

function arm(ground: Ground): FreshThreadStep {
  return Ground.match<FreshThreadStep>(ground, {
    NoProject: () => told("select a project first"),
    RunActive: () => told("a run is active; cancel it first"),
    Ready: () => stay(FreshThread.Armed()),
  });
}

export function advanceFreshThread(phase: FreshThread, event: FreshThreadEvent): FreshThreadStep {
  return FreshThreadEvent.match<FreshThreadStep>(event, {
    Clicked: ({ ground }) => clicked(phase, ground),
    Sent: () =>
      FreshThread.match<FreshThreadStep>(phase, {
        Idle: () => stay(phase),
        Armed: () => stay(FreshThread.Idle()),
        Starting: () => stay(phase),
        Told: () => stay(phase),
      }),
    SelectedProject: () => stay(FreshThread.Idle()),
    Succeeded: () => told("fresh thread started; repository files are untouched"),
    Refused: ({ wording }) => told(`not started: ${wording}`),
    Failed: () => told("request failed"),
  });
}

export function freshThreadWording(phase: FreshThread): string {
  return FreshThread.match(phase, {
    Idle: () => "",
    Armed: () => "click again to replace this conversation; repository files are untouched",
    Starting: () => "starting a fresh thread",
    Told: ({ wording }) => wording,
  });
}
