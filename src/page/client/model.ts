import * as Schema from "effect/Schema";
import { defineTaggedUnion } from "foldkit/schema";
import { BackendSetting } from "../../backend-setting.js";
import { Conversation } from "./conversation.js";
import { OutboxItem } from "./outbox.js";

export const Project = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  isHarness: Schema.Boolean,
  location: Schema.String,
});

export type Project = typeof Project.Type;

const GitHubConnection = Schema.Struct({
  state: Schema.String,
  detail: Schema.String,
  verificationUri: Schema.String,
  checked: Schema.String,
});

type GitHubConnection = typeof GitHubConnection.Type;

export const GitHubReport = defineTaggedUnion({
  Unknown: {},
  Known: { connection: GitHubConnection },
});

export type GitHubReport = typeof GitHubReport.Type;

const CodexLogin = Schema.Struct({
  attemptId: Schema.String,
  authorizeUrl: Schema.String,
});

export const CodexLoginConnection = Schema.Struct({
  connection: Schema.String,
  isConnected: Schema.Boolean,
  maybeLogin: Schema.Option(CodexLogin),
});

export type CodexLoginConnection = typeof CodexLoginConnection.Type;

export const ControlKind = Schema.Literals(["activate", "rollback"]);

export type ControlKind = typeof ControlKind.Type;

const ActiveGeneration = Schema.Struct({
  label: Schema.Number,
  harnessCommit: Schema.String,
  status: Schema.String,
});

export const GenerationReading = Schema.Struct({
  maybeActive: Schema.Option(ActiveGeneration),
  epoch: Schema.Number,
});

export type GenerationReading = typeof GenerationReading.Type;

export const StatusRead = defineTaggedUnion({
  Running: {},
  Succeeded: {},
  Failed: { wording: Schema.String },
});

export type StatusRead = typeof StatusRead.Type;

export const SubmitRequest = defineTaggedUnion({
  Idle: {},
  Running: {},
  Succeeded: {
    label: Schema.Number,
    epoch: Schema.Number,
    preparation: Schema.String,
    maybeDiagnostics: Schema.Option(Schema.String),
  },
  Failed: { wording: Schema.String },
});

export type SubmitRequest = typeof SubmitRequest.Type;

export const ControlRequest = defineTaggedUnion({
  Idle: {},
  Running: { sentEpoch: Schema.Number },
  Succeeded: { sentEpoch: Schema.Number, effect: Schema.String },
  Failed: { maybeSentEpoch: Schema.Option(Schema.Number), wording: Schema.String },
});

export type ControlRequest = typeof ControlRequest.Type;

export const ControlPanel = Schema.Struct({
  labelInput: Schema.String,
  request: ControlRequest,
});

export type ControlPanel = typeof ControlPanel.Type;

export const Model = Schema.Struct({
  pageError: Schema.String,
  isSidebarExpanded: Schema.Boolean,

  projectListStatus: Schema.String,
  projects: Schema.Array(Project),
  github: GitHubConnection,
  connectRepositoryInput: Schema.String,
  connectStatus: Schema.String,
  codexLogin: CodexLoginConnection,
  codexLoginCallbackInput: Schema.String,
  codexLoginResult: Schema.String,
  maybeBackend: Schema.Option(BackendSetting),
  backendResult: Schema.String,

  maybeProjectId: Schema.Option(Schema.String),
  conversationProject: Schema.String,
  conversationState: Schema.String,
  eventsStreamId: Schema.Number,
  conversation: Conversation,
  outbox: Schema.Array(OutboxItem),
  sending: Schema.Array(
    Schema.Struct({ requestId: Schema.String, projectId: Schema.String, text: Schema.String }),
  ),
  drafts: Schema.Record(Schema.String, Schema.String),

  prompt: Schema.String,
  runNote: Schema.String,
  isFreshArmed: Schema.Boolean,
  freshThreadStatus: Schema.String,

  maybeReading: Schema.Option(GenerationReading),
  statusRead: StatusRead,

  candidateCommitInput: Schema.String,
  submit: SubmitRequest,
  diagnosticsShown: Schema.Number,

  activate: ControlPanel,
  rollback: ControlPanel,
});

export type Model = typeof Model.Type;
