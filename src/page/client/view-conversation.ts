import type { Html, HtmlBuilder } from "foldkit/html";
import * as Option from "effect/Option";
import { OWNER_PAGE_IDS as ID } from "../element-ids.js";
import { Message } from "./message.js";
import type { Model } from "./model.js";
import { valueRow } from "./view-parts.js";
import { transcriptView } from "./view-transcript.js";

/**
 * The conversation column, which is the page's main work: the thread facts a reader needs to
 * trust what they see, the transcript a turn appends to while it runs (ADR-0037), and the
 * composer. Control-Enter sends, so a keyboard reader never has to leave the prompt to run a turn.
 */

function sendShortcut(key: string, modifiers: Readonly<{ ctrlKey: boolean; metaKey: boolean }>) {
  return key === "Enter" && (modifiers.ctrlKey || modifiers.metaKey)
    ? Option.some(Message.PressedSendShortcut())
    : Option.none();
}

function turnButtons(model: Model, h: HtmlBuilder<Message>): Html {
  const isRunning = model.turn._tag === "Streaming";

  return h.div(
    [h.Class("row")],
    [
      h.button(
        [
          h.Id(ID.sendTurnButton),
          h.Type("button"),
          h.Disabled(isRunning),
          h.OnClick(Message.ClickedSendTurn()),
        ],
        ["Send turn"],
      ),
      h.button(
        [
          h.Id(ID.cancelTurnButton),
          h.Type("button"),
          h.Disabled(!isRunning),
          h.OnClick(Message.ClickedCancelTurn()),
        ],
        ["Cancel turn"],
      ),
      h.button(
        [h.Id(ID.freshThreadButton), h.Type("button"), h.OnClick(Message.ClickedFreshThread())],
        ["Start fresh thread"],
      ),
    ],
  );
}

function composerView(model: Model, h: HtmlBuilder<Message>): Html {
  return h.div(
    [h.Class("composer")],
    [
      h.label([h.Class("field-label"), h.For(ID.promptInput)], ["prompt"]),
      h.textarea([
        h.Id(ID.promptInput),
        h.Rows(3),
        h.Placeholder("Ask this project's agent to do something. Control-Enter sends."),
        h.Value(model.prompt),
        h.OnInput((value) => Message.UpdatedPrompt({ value })),
        h.OnKeyDownPreventDefault(sendShortcut),
      ]),
      turnButtons(model, h),
      valueRow("turn", ID.turnState, model.turnState, h),
      valueRow("fresh thread", ID.freshThreadStatus, model.freshThreadStatus, h),
      h.p(
        [h.Class("note")],
        [
          "A fresh thread replaces this project's conversation and its compacted context. It leaves every repository file exactly as it is.",
        ],
      ),
    ],
  );
}

export function conversationView(model: Model, h: HtmlBuilder<Message>): Html {
  return h.section(
    [h.Id(ID.conversation), h.AriaLabel("Conversation")],
    [
      h.div(
        [h.Class("conversation-head")],
        [
          h.h2([h.Id(ID.conversationProject)], [model.conversationProject]),
          valueRow("thread", ID.conversationState, model.conversationState, h),
          valueRow("revision", ID.threadRevision, model.threadRevision, h),
          valueRow("turn active", ID.threadTurnActive, model.threadTurnActive, h),
          valueRow("messages", ID.threadMessageCount, model.threadMessageCount, h),
        ],
      ),
      transcriptView(model.transcript, ID.messageList, h),
      composerView(model, h),
    ],
  );
}
