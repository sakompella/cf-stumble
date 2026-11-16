import * as Option from "effect/Option";
import * as Record from "effect/Record";
import { DisconnectRepository } from "./commands-disconnect.js";
import { FetchProjects } from "./commands.js";
import { disconnectedWording } from "./disconnect-refusals.js";
import { Disconnect, type Model } from "./model.js";
import { selectedRepository } from "./selected-repository.js";
import { INITIAL_CONVERSATION } from "./update-conversation.js";
import { clearError, withError, type Handlers, type UpdateReturn } from "./update-shared.js";

function withoutProject(model: Model, projectId: string): Model {
  const kept = {
    ...model,
    drafts: Record.remove(model.drafts, projectId),
    outgoing: model.outgoing.filter((item) => item.projectId !== projectId),
  };

  return Option.contains(model.maybeProjectId, projectId)
    ? {
        ...kept,
        ...INITIAL_CONVERSATION,
        outgoing: kept.outgoing,
        maybeProjectId: Option.none(),
        conversationProject: "No project selected",
        prompt: "",
      }
    : kept;
}

function disconnected(
  model: Model,
  projectId: string,
  workspace: "removed" | "failed",
): UpdateReturn {
  const displayName =
    model.projects.find((project) => project.id === projectId)?.displayName ?? projectId;

  return {
    model: {
      ...withoutProject(model, projectId),
      disconnect: Disconnect.Told({ wording: disconnectedWording(displayName, workspace) }),
      projectListStatus: "reading",
    },
    commands: [FetchProjects()],
  };
}

export function disconnectHandlers(
  model: Model,
): Handlers<
  | "ClickedDisconnect"
  | "ConfirmedDisconnect"
  | "CancelledDisconnect"
  | "SucceededDisconnect"
  | "RejectedDisconnect"
  | "FailedDisconnect"
> {
  return {
    ClickedDisconnect: () =>
      Option.match(selectedRepository(model), {
        onNone: () => ({ model }),
        onSome: ({ id }) => ({
          model: { ...clearError(model), disconnect: Disconnect.Confirming({ projectId: id }) },
        }),
      }),
    ConfirmedDisconnect: () =>
      Disconnect.guards.Confirming(model.disconnect)
        ? {
            model: {
              ...model,
              disconnect: Disconnect.Disconnecting({ projectId: model.disconnect.projectId }),
            },
            commands: [DisconnectRepository({ projectId: model.disconnect.projectId })],
          }
        : { model },
    CancelledDisconnect: () => ({ model: { ...model, disconnect: Disconnect.Idle() } }),
    SucceededDisconnect: ({ projectId, workspace }) => disconnected(model, projectId, workspace),
    RejectedDisconnect: ({ wording }) => ({
      model: { ...model, disconnect: Disconnect.Told({ wording }) },
      commands: [FetchProjects()],
    }),
    FailedDisconnect: ({ detail }) => ({
      model: {
        ...withError(model, "the disconnect request", detail),
        disconnect: Disconnect.Told({ wording: "request failed" }),
      },
    }),
  };
}
