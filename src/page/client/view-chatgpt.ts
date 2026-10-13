import * as Option from "effect/Option";
import type { Html, HtmlBuilder } from "foldkit/html";
import { OWNER_PAGE_IDS as ID } from "../element-ids.js";
import { Message } from "./message.js";
import type { Model } from "./model.js";
import { controlRow, valueRow } from "./view-parts.js";

/**
 * The ChatGPT connection. While one is connected the owner can disconnect it; otherwise the owner
 * can start a sign-in, and a sign-in in progress shows its link and the box for the address the
 * browser ends on. Like the GitHub link, the sign-in link is data from the Worker and opens in a
 * tab of its own.
 */

function buttonRow(id: string, label: string, onClick: Message, h: HtmlBuilder<Message>): Html {
  return h.div(
    [h.Class("row")],
    [h.button([h.Id(id), h.Type("button"), h.OnClick(onClick)], [label])],
  );
}

function loginRows(model: Model, h: HtmlBuilder<Message>): readonly Html[] {
  return Option.match(model.chatgpt.maybeLogin, {
    onNone: () => [],
    onSome: (login) => [
      h.p(
        [h.Class("row")],
        [
          h.a(
            [
              h.Id(ID.chatgptSignInLink),
              h.Href(login.authorizeUrl),
              h.Rel("noreferrer noopener"),
              h.Target("_blank"),
            ],
            ["ChatGPT sign-in"],
          ),
        ],
      ),
      h.p(
        [h.Class("note")],
        ["sign in, then paste the address the browser ends on (http://127.0.0.1:1455/…)"],
      ),
      controlRow(
        {
          label: "address",
          inputId: ID.chatgptCallbackInput,
          isNumber: false,
          value: model.chatgptCallbackInput,
          onInput: (value) => Message.UpdatedChatGPTCallbackInput({ value }),
          buttonId: ID.chatgptFinishButton,
          buttonText: "Finish",
          onClick: Message.ClickedChatGPTFinish(),
        },
        h,
      ),
    ],
  });
}

export function chatGPTPanel(model: Model, h: HtmlBuilder<Message>): Html {
  return h.div(
    [h.Class("sidebar-panel")],
    [
      h.h3([], ["ChatGPT"]),
      valueRow("connection", ID.chatgptConnection, model.chatgpt.connection, h),
      ...(model.chatgpt.isConnected
        ? [
            buttonRow(
              ID.chatgptDisconnectButton,
              "Disconnect",
              Message.ClickedChatGPTDisconnect(),
              h,
            ),
          ]
        : [
            buttonRow(ID.chatgptConnectButton, "Connect ChatGPT", Message.ClickedChatGPTLogin(), h),
            ...loginRows(model, h),
          ]),
      valueRow("result", ID.chatgptResult, model.chatgptResult, h),
    ],
  );
}
