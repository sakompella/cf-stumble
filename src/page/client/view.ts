import type { Html, HtmlBuilder } from "foldkit/html";
import { OWNER_PAGE_IDS as ID } from "../element-ids.js";
import { Message } from "./message.js";
import type { Model } from "./model.js";
import { conversationView } from "./view-conversation.js";
import { backendPanel } from "./view-backend.js";
import { chatGPTPanel } from "./view-chatgpt.js";
import { connectPanels, projectListView } from "./view-repositories.js";
import { generationBarView } from "./view-generation.js";
import { valueRow } from "./view-parts.js";

function button(id: string, message: Message, label: string, h: HtmlBuilder<Message>): Html {
  return h.button([h.Id(id), h.Type("button"), h.OnClick(message)], [label]);
}

function gitHubPanel(model: Model, h: HtmlBuilder<Message>): Html {
  const uri = model.github.verificationUri;

  const link = h.a(
    [
      h.Id(ID.githubVerificationLink),
      ...(uri === "" ? [] : [h.Href(uri)]),
      h.Rel("noreferrer noopener"),
      h.Target("_blank"),
    ],
    [uri],
  );

  return h.div(
    [h.Class("sidebar-panel")],
    [
      h.h3([], ["GitHub"]),
      valueRow("connection", ID.githubState, model.github.state, h),
      valueRow("detail", ID.githubDetail, model.github.detail, h),
      valueRow("last checked", ID.githubChecked, model.github.checked, h),
      h.p([h.Class("row")], [link]),
      h.div(
        [h.Class("row")],
        [
          button(
            ID.authorizeButton,
            Message.ClickedAuthorize({ endpoint: "POST /api/github/authorization" }),
            "Authorize GitHub",
            h,
          ),
          button(
            ID.completeAuthorizationButton,
            Message.ClickedAuthorize({ endpoint: "POST /api/github/authorization/complete" }),
            "I authorized it",
            h,
          ),
          button(ID.refreshGitHubButton, Message.ClickedRefreshGitHub(), "Check again", h),
        ],
      ),
    ],
  );
}

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
