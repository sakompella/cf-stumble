import * as Option from "effect/Option";
import type { Html, HtmlBuilder } from "foldkit/html";
import type { BackendSetting } from "../../backend-setting.js";
import { OWNER_PAGE_IDS as ID } from "../element-ids.js";
import { Message } from "./message.js";
import type { Model } from "./model.js";
import { valueRow } from "./view-parts.js";

function choice(
  id: string,
  setting: BackendSetting,
  label: string,
  model: Model,
  h: HtmlBuilder<Message>,
): Html {
  return h.button(
    [
      h.Id(id),
      h.Type("button"),
      h.AriaPressed(Option.contains(model.maybeBackend, setting) ? "true" : "false"),
      h.OnClick(Message.ClickedBackend({ backend: setting })),
    ],
    [label],
  );
}

export function backendPanel(model: Model, h: HtmlBuilder<Message>): Html {
  return h.div(
    [h.Class("sidebar-panel")],
    [
      h.h3([], ["Workspace container"]),
      h.div(
        [h.Class("row")],
        [
          choice(ID.backendProviderButton, "provider", "Provider", model, h),
          choice(ID.backendCloudflareButton, "cloudflare", "Cloudflare", model, h),
        ],
      ),
      valueRow("result", ID.backendResult, model.backendResult, h),
    ],
  );
}
