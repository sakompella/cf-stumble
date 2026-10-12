import type { Update } from "foldkit";
import { FetchStatus } from "./commands.js";
import type { Message } from "./message.js";
import type { Model } from "./model.js";

export type UpdateReturn = Update.Return<Model, Message>;

type Tag = Message["_tag"];

/** The handlers for some of the Message tags. The full update spreads every group together. */
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
    model: { ...clearError(model), statusStatus: "reading" },
    commands: [FetchStatus()],
  };
}
