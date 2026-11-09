import * as Schema from "effect/Schema";
import { defineTaggedUnion } from "foldkit/schema";

export const StreamPhase = defineTaggedUnion({
  Idle: {},
  NoProjects: {},
  Reading: {},
  Live: {},
  Reconnecting: { detail: Schema.String },
  Refused: { wording: Schema.String },
  Unreadable: {},
});

export type StreamPhase = typeof StreamPhase.Type;

export function streamWording(phase: StreamPhase): string {
  return StreamPhase.match(phase, {
    Idle: () => "",
    NoProjects: () => "select a project first",
    Reading: () => "reading",
    Live: () => "live",
    Reconnecting: ({ detail }) => `reconnecting: ${detail}`,
    Refused: ({ wording }) => wording,
    Unreadable: () => "unreadable event from this Worker",
  });
}
