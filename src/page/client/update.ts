import * as Option from "effect/Option";
import type { Runtime } from "foldkit";
import { FetchGitHub, FetchProjects, FetchStatus } from "./commands.js";
import { ChatGPT } from "./chatgpt.js";
import { Message } from "./message.js";
import {
  ControlRequest,
  DEFAULT_RUN_BUDGET_MINUTES,
  Disconnect,
  StatusRead,
  SubmitRequest,
  type Model,
} from "./model.js";
import { controlHandlers, statusHandlers, submitHandlers } from "./update-generation.js";
import {
  backendHandlers,
  chatGPTHandlers,
  connectHandlers,
  disconnectHandlers,
  FetchBackend,
  FetchChatGPT,
  gitHubHandlers,
  projectHandlers,
} from "./update-projects.js";
import type { UpdateReturn } from "./update-shared.js";
import { conversationHandlers, INITIAL_CONVERSATION } from "./update-conversation.js";

const EMPTY_PANEL = { labelInput: "", request: ControlRequest.Idle() };

export const init: Runtime.ElementInit<Model, Message> = () => ({
  model: {
    pageError: "",
    isOnline: true,
    isSidebarExpanded: true,
    projectListStatus: "reading",
    projects: [],
    github: { state: "", detail: "", verificationUri: "", checked: "" },
    connectRepositoryInput: "",
    connectStatus: "",
    disconnect: Disconnect.Idle(),
    chatgpt: ChatGPT.Unknown(),
    chatgptResult: "",
    isChatGPTDisconnectAsked: false,
    maybeBackend: Option.none(),
    backendResult: "",
    maybeProjectId: Option.none(),
    maybeHeldTranscript: Option.none(),
    conversationProject: "No project selected",
    eventsStreamId: 0,
    ...INITIAL_CONVERSATION,
    drafts: {},
    prompt: "",
    runBudget: DEFAULT_RUN_BUDGET_MINUTES,
    queuedAtCancel: 0,
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
    ...disconnectHandlers(model),
    ...gitHubHandlers(model),
    ...chatGPTHandlers(model),
    ...backendHandlers(model),
    ...conversationHandlers(model),
    ...statusHandlers(model),
    ...submitHandlers(model),
    ...controlHandlers(model),
    ChoseRunBudget: ({ minutes }) => ({ model: { ...model, runBudget: minutes } }),
    CompletedFollowTranscript: () => ({ model }),
  });
}
