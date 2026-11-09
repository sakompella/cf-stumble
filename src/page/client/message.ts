import * as Schema from "effect/Schema";
import { defineMessageUnion } from "foldkit/message";
import { BackendSetting } from "../../backend-setting.js";
import { ChatGPT } from "./chatgpt.js";
import { Conversation } from "./conversation.js";
import { ControlKind, GenerationReading, GitHubReport, Project } from "./model.js";

export const Message = defineMessageUnion({
  ClickedSidebarToggle: {},
  ClickedProject: { projectId: Schema.String },
  UpdatedConnectRepositoryInput: { value: Schema.String },
  ClickedConnect: {},
  ClickedAuthorize: { path: Schema.String },
  ClickedRefreshGitHub: {},
  ClickedChatGPTLogin: {},
  UpdatedChatGPTCallbackInput: { value: Schema.String },
  ClickedChatGPTFinish: {},
  ClickedChatGPTDisconnect: {},
  ClickedBackend: { backend: BackendSetting },

  UpdatedPrompt: { value: Schema.String },
  ClickedSendTurn: {},
  PressedSendShortcut: {},
  ClickedCancelTurn: {},
  ClickedFreshThread: {},
  ClickedRetrySend: { requestId: Schema.String },

  ClickedRefreshStatus: {},
  UpdatedCandidateCommitInput: { value: Schema.String },
  ClickedSubmitCandidate: {},
  UpdatedControlLabelInput: { kind: ControlKind, value: Schema.String },
  ClickedControl: { kind: ControlKind },

  SucceededFetchStatus: { reading: GenerationReading },
  RejectedFetchStatus: { wording: Schema.String },
  FailedFetchStatus: { detail: Schema.String },

  SucceededFetchProjects: { projects: Schema.Array(Project) },
  RejectedFetchProjects: { wording: Schema.String },
  FailedFetchProjects: { detail: Schema.String },

  SucceededConnect: {
    isAlreadyConnected: Schema.Boolean,
    maybeGitHub: Schema.Option(GitHubReport),
  },
  RejectedConnect: { wording: Schema.String, maybeGitHub: Schema.Option(GitHubReport) },
  FailedConnect: { detail: Schema.String },

  SucceededGitHub: { github: GitHubReport },
  RejectedGitHub: { wording: Schema.String },
  FailedGitHub: { detail: Schema.String },

  SucceededChatGPT: { chatgpt: ChatGPT },
  RejectedChatGPT: { wording: Schema.String, maybeChatGPT: Schema.Option(ChatGPT) },
  FailedChatGPT: { detail: Schema.String },

  SucceededBackend: { backend: BackendSetting },
  RejectedBackend: { wording: Schema.String },
  FailedBackend: { detail: Schema.String },

  MintedRequestId: { projectId: Schema.String, requestId: Schema.String, content: Schema.String },
  SucceededSend: { requestId: Schema.String, submissionId: Schema.Number },
  RejectedSend: { requestId: Schema.String, wording: Schema.String },
  FailedSend: { requestId: Schema.String, detail: Schema.String },

  SucceededAbort: {},
  RejectedAbort: { wording: Schema.String },
  FailedAbort: { detail: Schema.String },

  SucceededFreshThread: { streamId: Schema.Number },
  RejectedFreshThread: { streamId: Schema.Number, wording: Schema.String },
  FailedFreshThread: { streamId: Schema.Number, detail: Schema.String },

  SucceededSubmit: {
    label: Schema.Number,
    epoch: Schema.Number,
    preparation: Schema.String,
    maybeDiagnostics: Schema.Option(Schema.String),
  },
  RejectedSubmit: { wording: Schema.String },
  FailedSubmit: { detail: Schema.String },

  SucceededControl: { kind: ControlKind, sentEpoch: Schema.Number, effect: Schema.String },
  RejectedControl: { kind: ControlKind, sentEpoch: Schema.Number, wording: Schema.String },
  FailedControl: { kind: ControlKind, sentEpoch: Schema.Number, detail: Schema.String },

  ReceivedConversation: { streamId: Schema.Number, conversation: Conversation },
  ClickedLoadEarlier: {},
  ClickedFillGap: { itemIndex: Schema.Number },
  LoadedTranscript: {
    streamId: Schema.Number,
    maybeItems: Schema.Option(Conversation.fields.items),
  },
  FailedLoadTranscript: { streamId: Schema.Number, detail: Schema.String },
  ReceivedUnreadableEvent: { streamId: Schema.Number },
  RefusedEvents: { streamId: Schema.Number, wording: Schema.String },
  DisconnectedEvents: { streamId: Schema.Number, detail: Schema.String },

  CompletedFollowTranscript: {},
  SettledTranscript: {},
});

export type Message = typeof Message.Type;
