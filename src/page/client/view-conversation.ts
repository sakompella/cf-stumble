import { createLazy, type Html, type HtmlBuilder } from "foldkit/html";
import * as Option from "effect/Option";
import { OWNER_PAGE_IDS as ID } from "../element-ids.js";
import { Message } from "./message.js";
import { FreshThread, freshThreadWording } from "./fresh-thread.js";
import { RunBudget, type Model } from "./model.js";
import { streamWording } from "./stream-phase.js";
import { statusText } from "./view-parts.js";
import { transcriptOf } from "./transcript.js";
import { transcriptView } from "./view-transcript.js";

const lazyTranscript = createLazy();

function conversationTranscript(
  conversation: Model["conversation"],
  outgoing: Model["outgoing"],
  projectId: string,
  h: HtmlBuilder<Message>,
): Html {
  return transcriptView(transcriptOf(conversation, outgoing, projectId), ID.messageList, h);
}

function sendShortcut(key: string, modifiers: Readonly<{ ctrlKey: boolean; metaKey: boolean }>) {
  return key === "Enter" && (modifiers.ctrlKey || modifiers.metaKey)
    ? Option.some(Message.PressedSendShortcut())
    : Option.none();
}

function runState(model: Model): string {
  const { isRunning, inbox } = model.conversation;

  if (!isRunning) {
    return model.runNote;
  }

  return inbox.length === 0 ? "running" : `running · ${inbox.length} queued`;
}

function turnButtons(model: Model, h: HtmlBuilder<Message>): Html {
  const isCancellable = model.conversation.isRunning || model.conversation.inbox.length > 0;

  return h.div(
    [h.Class("row")],
    [
      h.button(
        [h.Id(ID.sendTurnButton), h.Type("button"), h.OnClick(Message.ClickedSendTurn())],
        ["Send turn"],
      ),
      h.button(
        [
          h.Id(ID.cancelTurnButton),
          h.Type("button"),
          h.Disabled(!isCancellable),
          h.OnClick(Message.ClickedCancelTurn()),
        ],
        ["Cancel turn"],
      ),
      h.button(
        [
          h.Id(ID.freshThreadButton),
          h.Type("button"),
          h.Disabled(FreshThread.guards.Starting(model.freshThread)),
          h.OnClick(Message.ClickedFreshThread()),
        ],
        ["Start fresh thread"],
      ),
      statusText(ID.turnState, runState(model), h),
    ],
  );
}

function budgetButtons(model: Model, h: HtmlBuilder<Message>): Html {
  return h.div(
    [h.Class("row"), h.Role("group"), h.AriaLabel("time budget")],
    [
      h.span([h.Class("field-label")], ["time budget"]),
      ...RunBudget.literals.map((minutes) =>
        h.button(
          [
            h.Type("button"),
            h.AriaPressed(model.runBudget === minutes ? "true" : "false"),
            h.OnClick(Message.ChoseRunBudget({ minutes })),
          ],
          [`${minutes} min`],
        ),
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
        h.Placeholder("Control-Enter sends."),
        h.Value(model.prompt),
        h.OnInput((value) => Message.UpdatedPrompt({ value })),
        h.OnKeyDownPreventDefault(sendShortcut),
      ]),
      budgetButtons(model, h),
      turnButtons(model, h),
      h.p([h.Class("note"), h.Id(ID.freshThreadStatus)], [freshThreadWording(model.freshThread)]),
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
          h.span([h.Class("note"), h.Id(ID.conversationState)], [streamWording(model.streamPhase)]),
        ],
      ),
      lazyTranscript(conversationTranscript, [
        model.conversation,
        model.outgoing,
        Option.getOrElse(model.maybeProjectId, () => ""),
        h,
      ]),
      composerView(model, h),
    ],
  );
}
