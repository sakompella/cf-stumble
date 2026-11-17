import { type Html, type HtmlBuilder } from "foldkit/html";
import { OWNER_PAGE_IDS as ID } from "../element-ids.js";
import { isRunning } from "./conversation.js";
import { FreshThread } from "./fresh-thread.js";
import { Message } from "./message.js";
import type { Model } from "./model.js";
import { phaseWording } from "./run-phase.js";
import { statusText } from "./view-parts.js";

function runState(model: Model): string {
  const { inbox } = model.conversation;

  if (!isRunning(model.conversation)) {
    return model.runNote;
  }

  const running = inbox.length === 0 ? "running" : `running · ${inbox.length} queued`;

  return model.runNote === "" ? running : `${running} · ${model.runNote}`;
}

export function turnButtons(model: Model, h: HtmlBuilder<Message>): Html {
  const isCancellable = isRunning(model.conversation) || model.conversation.inbox.length > 0;

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
        [
          FreshThread.guards.Armed(model.freshThread)
            ? "Confirm fresh thread"
            : "Start fresh thread",
        ],
      ),
      statusText(ID.turnState, runState(model), h),
      h.span([h.Class("note"), h.Id(ID.runPhase)], [phaseWording(model.conversation.run)]),
    ],
  );
}
