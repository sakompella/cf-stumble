import type { Html, HtmlBuilder } from "foldkit/html";
import { OWNER_PAGE_IDS as ID } from "../element-ids.js";
import { Message } from "./message.js";
import type { Model } from "./model.js";
import { conversationView } from "./view-conversation.js";
import { backendPanel } from "./view-backend.js";
import { chatGPTPanel } from "./view-chatgpt.js";
import { gitHubPanel } from "./view-github.js";
import { connectPanels, projectListView } from "./view-repositories.js";
import { generationBarView } from "./view-generation.js";

function sidebarView(model: Model, h: HtmlBuilder<Message>): Html {
  const isExpanded = model.isSidebarExpanded;

  return h.div(
    [h.Class("sidebar-column")],
    [
      h.button(
        [
          h.Id(ID.sidebarToggle),
          h.Type("button"),
          h.AriaExpanded(isExpanded),
          h.AriaControls(ID.sidebar),
          h.OnClick(Message.ClickedSidebarToggle()),
        ],
        [isExpanded ? "Hide" : "Show projects"],
      ),
      h.aside(
        [h.Id(ID.sidebar), h.AriaLabel("Projects")],
        [
          h.h2([], ["Projects"]),
          h.p([h.Class("note"), h.Id(ID.projectListStatus)], [model.projectListStatus]),
          projectListView(model, h),
          gitHubPanel(model, h),
          chatGPTPanel(model, h),
          backendPanel(model, h),
          ...connectPanels(model, h),
        ],
      ),
    ],
  );
}

export function view(model: Model, h: HtmlBuilder<Message>): Html {
  return h.main(
    [h.Id(ID.root)],
    [
      h.header(
        [],
        [
          h.h1([], ["cf-stumble"]),
          h.p([h.Id(ID.pageError)], model.pageError === "" ? [] : [model.pageError]),
        ],
      ),
      generationBarView(model, h),
      h.div(
        [h.Id(ID.layout), ...(model.isSidebarExpanded ? [] : [h.Class("sidebar-collapsed")])],
        [sidebarView(model, h), conversationView(model, h)],
      ),
    ],
  );
}
