import * as Option from "effect/Option";
import type { Runtime } from "foldkit";
import { FetchChatGPT, FetchGitHub, FetchProjects, FetchStatus } from "./commands.js";
import { Message } from "./message.js";
import { ControlRequest, StatusRead, SubmitRequest, type Model } from "./model.js";
import { StreamPhase } from "./stream-phase.js";
import { controlHandlers, statusHandlers, submitHandlers } from "./update-generation.js";
import {
  backendHandlers,
  chatGPTHandlers,
  connectHandlers,
  FetchBackend,
  gitHubHandlers,
  projectHandlers,
} from "./update-projects.js";
import type { UpdateReturn } from "./update-shared.js";
import { composerHandlers, INITIAL_CONVERSATION, streamHandlers } from "./update-conversation.js";

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
    chatgpt: { connection: "", isConnected: false, maybeLogin: Option.none() },
    chatgptCallbackInput: "",
    chatgptResult: "",
    maybeBackend: Option.none(),
    backendResult: "",
    maybeProjectId: Option.none(),
    conversationProject: "No project selected",
    streamPhase: StreamPhase.Idle(),
    eventsStreamId: 0,
    ...INITIAL_CONVERSATION,
    drafts: {},
    prompt: "",
    maybeReading: Option.none(),
    statusRead: StatusRead.Running(),
    candidateCommitInput: "",
    submit: SubmitRequest.Idle(),
    diagnosticsShown: 0,
    activate: EMPTY_PANEL,
    rollback: EMPTY_PANEL,
  },
  commands: [FetchStatus(), FetchProjects(), FetchGitHub(), FetchChatGPT(), FetchBackend()],
});

export function update(model: Model, message: Message): UpdateReturn {
  return Message.match<UpdateReturn>(message, {
    ...projectHandlers(model),
    ...connectHandlers(model),
    ...gitHubHandlers(model),
    ...chatGPTHandlers(model),
    ...backendHandlers(model),
    ...composerHandlers(model),
    ...streamHandlers(model),
    ...statusHandlers(model),
    ...submitHandlers(model),
    ...controlHandlers(model),
    CompletedFollowTranscript: () => ({ model }),
    SettledTranscript: () => ({ model }),
  });
}
