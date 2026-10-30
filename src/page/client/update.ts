import * as Option from "effect/Option";
import type { Runtime } from "foldkit";
import { FetchChatGPT, FetchGitHub, FetchProjects, FetchStatus } from "./commands.js";
import { Message } from "./message.js";
import { EMPTY_CONVERSATION } from "./conversation.js";
import type { Model } from "./model.js";
import { controlHandlers, statusHandlers, submitHandlers } from "./update-generation.js";
import {
  chatGPTHandlers,
  connectHandlers,
  gitHubHandlers,
  projectHandlers,
} from "./update-projects.js";
import type { UpdateReturn } from "./update-shared.js";
import { composerHandlers, streamHandlers } from "./update-conversation.js";

const EMPTY_PANEL = { labelInput: "", status: "", sentEpoch: "", effect: "" };

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
    maybeProjectId: Option.none(),
    conversationProject: "No project selected",
    conversationState: "",
    eventsStreamId: 0,
    conversation: EMPTY_CONVERSATION,
    outbox: [],
    prompt: "",
    runNote: "",
    isFreshArmed: false,
    freshThreadStatus: "",
    activeGenerationLabel: "",
    activeGenerationCommit: "",
    activeGenerationStatus: "",
    generationEpoch: "",
    statusStatus: "reading",
    candidateCommitInput: "",
    submitStatus: "",
    submitGenerationLabel: "",
    submitEpoch: "",
    submitPreparation: "",
    maybeDiagnostics: Option.none(),
    diagnosticsShown: 0,
    activate: EMPTY_PANEL,
    rollback: EMPTY_PANEL,
  },
  commands: [FetchStatus(), FetchProjects(), FetchGitHub(), FetchChatGPT()],
});

export function update(model: Model, message: Message): UpdateReturn {
  return Message.match<UpdateReturn>(message, {
    ...projectHandlers(model),
    ...connectHandlers(model),
    ...gitHubHandlers(model),
    ...chatGPTHandlers(model),
    ...composerHandlers(model),
    ...streamHandlers(model),
    ...statusHandlers(model),
    ...submitHandlers(model),
    ...controlHandlers(model),
    CompletedFollowTranscript: () => ({ model }),
  });
}
