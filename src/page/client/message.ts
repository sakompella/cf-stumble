import * as Schema from "effect/Schema";
import { defineMessageUnion } from "foldkit/message";
import { ControlKind, GitHubReport, Project, ThreadFacts } from "./model.js";
import { TurnFrame } from "./frames.js";

/**
 * Every fact the page can learn. A request's result arrives as one of three Messages: it
 * succeeded, the Worker refused it (`Rejected*`, carrying the wording the page shows), or it never
 * reached the Worker (`Failed*`, carrying the transport detail for the page error banner).
 */
export const Message = defineMessageUnion({
  ClickedSidebarToggle: {},
  ClickedProject: { projectId: Schema.String },
  UpdatedConnectRepositoryInput: { value: Schema.String },
  ClickedConnect: {},
  ClickedAuthorize: { path: Schema.String },

  UpdatedPrompt: { value: Schema.String },
  ClickedSendTurn: {},
  PressedSendShortcut: {},
  ClickedCancelTurn: {},
  ClickedFreshThread: {},

  ClickedRefreshStatus: {},
  UpdatedCandidateCommitInput: { value: Schema.String },
  ClickedSubmitCandidate: {},
  UpdatedControlLabelInput: { kind: ControlKind, value: Schema.String },
  ClickedControl: { kind: ControlKind },

  SucceededFetchStatus: {
    label: Schema.String,
    commit: Schema.String,
    status: Schema.String,
    epoch: Schema.String,
  },
  RejectedFetchStatus: { wording: Schema.String },
  FailedFetchStatus: { detail: Schema.String },

  SucceededFetchProjects: {
    projects: Schema.Array(Project),
    github: GitHubReport,
  },
  RejectedFetchProjects: { wording: Schema.String },
  FailedFetchProjects: { detail: Schema.String },

  SucceededConnect: {
    isAlreadyConnected: Schema.Boolean,
    maybeGitHub: Schema.Option(GitHubReport),
  },
  RejectedConnect: { wording: Schema.String, maybeGitHub: Schema.Option(GitHubReport) },
  FailedConnect: { detail: Schema.String },

  SucceededAuthorize: { github: GitHubReport },
  RejectedAuthorize: { wording: Schema.String },
  FailedAuthorize: { detail: Schema.String },

  SucceededFetchThread: { selection: Schema.Number, isQuiet: Schema.Boolean, thread: ThreadFacts },
  RejectedFetchThread: { selection: Schema.Number, wording: Schema.String },
  FailedFetchThread: { selection: Schema.Number, detail: Schema.String },

  SucceededFreshThread: { selection: Schema.Number, thread: ThreadFacts },
  RejectedFreshThread: { selection: Schema.Number, wording: Schema.String },
  FailedFreshThread: { selection: Schema.Number, detail: Schema.String },

  SucceededSubmit: {
    label: Schema.String,
    epoch: Schema.String,
    preparation: Schema.String,
    maybeDiagnostics: Schema.Option(Schema.String),
  },
  RejectedSubmit: { wording: Schema.String },
  FailedSubmit: { detail: Schema.String },

  SucceededControl: { kind: ControlKind, effect: Schema.String },
  RejectedControl: { kind: ControlKind, wording: Schema.String },
  FailedControl: { kind: ControlKind, detail: Schema.String },

  ReceivedTurnFrame: { turnId: Schema.Number, frame: TurnFrame },
  ReceivedUnreadableFrame: { turnId: Schema.Number },
  RefusedTurn: { turnId: Schema.Number, wording: Schema.String },
  EndedTurnStream: { turnId: Schema.Number },
  DisconnectedTurnStream: { turnId: Schema.Number, detail: Schema.String },

  CompletedFollowTranscript: {},
});

export type Message = typeof Message.Type;
