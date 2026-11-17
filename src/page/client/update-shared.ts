import * as Option from "effect/Option";
import * as Record from "effect/Record";
import type { Update } from "foldkit";
import { FetchStatus } from "./commands.js";
import { EMPTY_CONVERSATION } from "./conversation.js";
import { FreshThread } from "./fresh-thread.js";
import type { Message } from "./message.js";
import { StatusRead, type Model } from "./model.js";
import { StreamPhase } from "./stream-phase.js";
import type { TranscriptService } from "./transcript-store.js";

export type UpdateReturn = Update.Return<Model, Message, TranscriptService>;

type Tag = Message["_tag"];

export type Handlers<Tags extends Tag> = {
  readonly [K in Tags]: (message: Extract<Message, { readonly _tag: K }>) => UpdateReturn;
};

export function clearError(model: Model): Model {
  return { ...model, pageError: "" };
}

export function withError(model: Model, where: string, detail: string): Model {
  return { ...model, pageError: `${where} could not reach this Worker: ${detail}` };
}

export function refreshStatus(model: Model): UpdateReturn {
  return {
    model: { ...clearError(model), statusRead: StatusRead.Running() },
    commands: [FetchStatus()],
  };
}

export const INITIAL_CONVERSATION = {
  conversation: EMPTY_CONVERSATION,
  outgoing: [],
  runNote: "",
  freshThread: FreshThread.Idle(),
  streamPhase: StreamPhase.Idle(),
} satisfies Partial<Model>;

export function withoutProject(model: Model, projectId: string): Model {
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
