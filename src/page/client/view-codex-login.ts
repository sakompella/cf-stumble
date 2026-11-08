import * as Option from "effect/Option";
import type { Html, HtmlBuilder } from "foldkit/html";
import { OWNER_PAGE_IDS as ID } from "../element-ids.js";
import { Message } from "./message.js";
import type { Model } from "./model.js";
import { controlRow, valueRow } from "./view-parts.js";

function buttonRow(id: string, label: string, onClick: Message, h: HtmlBuilder<Message>): Html {
  return h.div(
    [h.Class("row")],
    [h.button([h.Id(id), h.Type("button"), h.OnClick(onClick)], [label])],
  );
}

function loginRows(model: Model, h: HtmlBuilder<Message>): readonly Html[] {
  return Option.match(model.codexLogin.maybeLogin, {
    onNone: () => [],
    onSome: (login) => [
      h.p(
        [h.Class("row")],
        [
          h.a(
            [
              h.Id(ID.codexLoginSignInLink),
              h.Href(login.authorizeUrl),
              h.Rel("noreferrer noopener"),
              h.Target("_blank"),
            ],
            ["Codex sign-in"],
          ),
        ],
      ),
      h.p([h.Class("note")], ["Sign in, then paste the final address (http://127.0.0.1:1455/…)."]),
      controlRow(
        {
          label: "address",
          inputId: ID.codexLoginCallbackInput,
          isNumber: false,
          value: model.codexLoginCallbackInput,
          onInput: (value) => Message.UpdatedCodexLoginCallbackInput({ value }),
          buttonId: ID.codexLoginFinishButton,
          buttonText: "Finish",
          onClick: Message.ClickedCodexLoginFinish(),
        },
        h,
      ),
    ],
  });
}

export function codexLoginPanel(model: Model, h: HtmlBuilder<Message>): Html {
  return h.div(
    [h.Class("sidebar-panel")],
    [
      h.h3([], ["Codex"]),
      valueRow("connection", ID.codexLoginConnection, model.codexLogin.connection, h),
      ...(model.codexLogin.isConnected
        ? [
            buttonRow(
              ID.codexLoginDisconnectButton,
              "Disconnect",
              Message.ClickedCodexLoginDisconnect(),
              h,
            ),
          ]
        : [
            buttonRow(ID.codexLoginConnectButton, "Connect Codex", Message.ClickedCodexLogin(), h),
            ...loginRows(model, h),
          ]),
      valueRow("result", ID.codexLoginResult, model.codexLoginResult, h),
    ],
  );
}
