import * as Schema from "effect/Schema";
import { defineTaggedUnion } from "foldkit/schema";
import { Conversation } from "./conversation.js";
import { OutboxItem } from "./transcript.js";

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
  /** Empty when this state is not the result of a check. */
  checked: Schema.String,
});

type GitHubConnection = typeof GitHubConnection.Type;

export const GitHubReport = defineTaggedUnion({
  Unknown: {},
  Known: { connection: GitHubConnection },
});

export type GitHubReport = typeof GitHubReport.Type;

const ChatGPTLogin = Schema.Struct({
  attemptId: Schema.String,
  authorizeUrl: Schema.String,
});

export const ChatGPTConnection = Schema.Struct({
  connection: Schema.String,
  isConnected: Schema.Boolean,
  maybeLogin: Schema.Option(ChatGPTLogin),
});

export type ChatGPTConnection = typeof ChatGPTConnection.Type;

export const ControlKind = Schema.Literals(["activate", "rollback"]);

export type ControlKind = typeof ControlKind.Type;

export const ControlPanel = Schema.Struct({
  labelInput: Schema.String,
  status: Schema.String,
  sentEpoch: Schema.String,
  effect: Schema.String,
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
  chatgpt: ChatGPTConnection,
  chatgptCallbackInput: Schema.String,
  chatgptResult: Schema.String,

  maybeProjectId: Schema.Option(Schema.String),
  conversationProject: Schema.String,
  conversationState: Schema.String,
  /**
   * Names the open events stream. Selecting a project or starting a fresh thread opens a new one,
   * and a Message from an older stream is dropped.
   */
  eventsStreamId: Schema.Number,
  conversation: Conversation,
  outbox: Schema.Array(OutboxItem),

  prompt: Schema.String,
  /** What became of this page's last send, cancel or run, shown while no run is active. */
  runNote: Schema.String,
  isFreshArmed: Schema.Boolean,
  freshThreadStatus: Schema.String,

  activeGenerationLabel: Schema.String,
  activeGenerationCommit: Schema.String,
  activeGenerationStatus: Schema.String,
  generationEpoch: Schema.String,
  statusStatus: Schema.String,

  candidateCommitInput: Schema.String,
  submitStatus: Schema.String,
  submitGenerationLabel: Schema.String,
  submitEpoch: Schema.String,
  submitPreparation: Schema.String,
  maybeDiagnostics: Schema.Option(Schema.String),
  /**
   * The panel is keyed by it, so each new output is a new, closed disclosure and the reader's own open
   * or close never races a render.
   */
  diagnosticsShown: Schema.Number,

  activate: ControlPanel,
  rollback: ControlPanel,
});

export type Model = typeof Model.Type;
