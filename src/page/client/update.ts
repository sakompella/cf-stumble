import * as Option from "effect/Option";
import type { Runtime } from "foldkit";
import { FetchProjects, FetchStatus } from "./commands.js";
import { Message } from "./message.js";
import { Turn, type Model } from "./model.js";
import { controlHandlers, statusHandlers, submitHandlers } from "./update-generation.js";
import { connectHandlers, gitHubHandlers, projectHandlers } from "./update-projects.js";
import type { UpdateReturn } from "./update-shared.js";
import { threadHandlers } from "./update-thread.js";
import { turnHandlers } from "./update-turn.js";

const EMPTY_PANEL = { labelInput: "", status: "", sentEpoch: "", effect: "" };

export const init: Runtime.ElementInit<Model, Message> = () => ({
  model: {
    pageError: "",
    isSidebarExpanded: true,
    projectListStatus: "reading",
    projects: [],
    github: { state: "", detail: "", verificationUri: "" },
    connectRepositoryInput: "",
    connectStatus: "",
    selection: 0,
    maybeProjectId: Option.none(),
    conversationProject: "No project selected",
    conversationState: "",
    threadRevision: "",
    threadTurnActive: "",
    threadMessageCount: "",
    transcript: [],
    isAssistantOpen: false,
    prompt: "",
    turnCount: 0,
    turn: Turn.Idle(),
    turnState: "",
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
  commands: [FetchStatus(), FetchProjects()],
});

export function update(model: Model, message: Message): UpdateReturn {
  return Message.match<UpdateReturn>(message, {
    ...projectHandlers(model),
    ...connectHandlers(model),
    ...gitHubHandlers(model),
    ...threadHandlers(model),
    ...turnHandlers(model),
    ...statusHandlers(model),
    ...submitHandlers(model),
    ...controlHandlers(model),
    CompletedFollowTranscript: () => ({ model }),
  });
}
