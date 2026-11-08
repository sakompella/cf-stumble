import * as Option from "effect/Option";
import type { Runtime } from "foldkit";
import { FetchCodexLogin, FetchGitHub, FetchProjects, FetchStatus } from "./commands.js";
import { Message } from "./message.js";
import { EMPTY_CONVERSATION } from "./conversation.js";
import { ControlRequest, StatusRead, SubmitRequest, type Model } from "./model.js";
import { controlHandlers, statusHandlers, submitHandlers } from "./update-generation.js";
import {
  backendHandlers,
  codexLoginHandlers,
  connectHandlers,
  FetchBackend,
  gitHubHandlers,
  projectHandlers,
} from "./update-projects.js";
import type { UpdateReturn } from "./update-shared.js";
import { composerHandlers, streamHandlers } from "./update-conversation.js";

const EMPTY_PANEL = { labelInput: "", request: ControlRequest.Idle() };

export const init: Runtime.ElementInit<Model, Message> = () => ({
  model: {
    pageError: "",
    isSidebarExpanded: true,
    projectListStatus: "reading",
    projects: [],
    github: { state: "", detail: "", verificationUri: "", checked: "" },
    connectRepositoryInput: "",
    connectStatus: "",
    codexLogin: { connection: "", isConnected: false, maybeLogin: Option.none() },
    codexLoginCallbackInput: "",
    codexLoginResult: "",
    maybeBackend: Option.none(),
    backendResult: "",
    maybeProjectId: Option.none(),
    conversationProject: "No project selected",
    conversationState: "",
    eventsStreamId: 0,
    conversation: EMPTY_CONVERSATION,
    outbox: [],
    sending: [],
    drafts: {},
    prompt: "",
    runNote: "",
    isFreshArmed: false,
    freshThreadStatus: "",
    maybeReading: Option.none(),
    statusRead: StatusRead.Running(),
    candidateCommitInput: "",
    submit: SubmitRequest.Idle(),
    diagnosticsShown: 0,
    activate: EMPTY_PANEL,
    rollback: EMPTY_PANEL,
  },
  commands: [FetchStatus(), FetchProjects(), FetchGitHub(), FetchCodexLogin(), FetchBackend()],
});

export function update(model: Model, message: Message): UpdateReturn {
  return Message.match<UpdateReturn>(message, {
    ...projectHandlers(model),
    ...connectHandlers(model),
    ...gitHubHandlers(model),
    ...codexLoginHandlers(model),
    ...backendHandlers(model),
    ...composerHandlers(model),
    ...streamHandlers(model),
    ...statusHandlers(model),
    ...submitHandlers(model),
    ...controlHandlers(model),
    CompletedFollowTranscript: () => ({ model }),
  });
}
