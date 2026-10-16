import * as Option from "effect/Option";
import type { Html, HtmlBuilder } from "foldkit/html";
import { OWNER_PAGE_CLASSES as CLASS, OWNER_PAGE_IDS as ID } from "../element-ids.js";
import { Message } from "./message.js";
import type { Model, Project } from "./model.js";
import { conversationView } from "./view-conversation.js";
import { chatGPTPanel } from "./view-chatgpt.js";
import { generationBarView } from "./view-generation.js";
import { controlRow, valueRow } from "./view-parts.js";

/**
 * The whole page: the generation bar, then a sidebar of connected projects beside the
 * conversation. The sidebar toggle sits above the panel it controls rather than inside it, so
 * hiding the projects never hides the control that shows them again.
 */

function projectButton(project: Project, model: Model, h: HtmlBuilder<Message>): Html {
  const isSelected = Option.contains(model.maybeProjectId, project.id);

  return h.li(
    [h.Key(project.id)],
    [
      h.button(
        [
          h.Class(
            isSelected ? `${CLASS.projectButton} ${CLASS.selectedProject}` : CLASS.projectButton,
          ),
          h.Type("button"),
          h.DataAttribute("project-id", project.id),
          h.AriaCurrent(isSelected ? "true" : "false"),
          h.OnClick(Message.ClickedProject({ projectId: project.id })),
        ],
        [project.displayName, h.span([h.Class("repo")], [project.location])],
      ),
    ],
  );
}

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
      h.p([h.Class("row")], [link]),
      h.div(
        [h.Class("row")],
        [
          button(
            ID.authorizeButton,
            Message.ClickedAuthorize({ path: "/api/github/authorization" }),
            "Authorize GitHub",
            h,
          ),
          button(
            ID.completeAuthorizationButton,
            Message.ClickedAuthorize({ path: "/api/github/authorization/complete" }),
            "I authorized it",
            h,
          ),
          button(ID.refreshGitHubButton, Message.ClickedRefreshGitHub(), "Check again", h),
        ],
      ),
      h.p(
        [h.Class("note")],
        [
          "cf-stumble never asks for a token here. Open the verification link, enter the code at GitHub, then use the second button.",
        ],
      ),
    ],
  );
}

function connectPanel(model: Model, h: HtmlBuilder<Message>): Html {
  return h.div(
    [h.Class("sidebar-panel")],
    [
      h.h3([], ["Connect a repository"]),
      controlRow(
        {
          label: "repository url",
          inputId: ID.connectRepositoryInput,
          isNumber: false,
          value: model.connectRepositoryInput,
          onInput: (value) => Message.UpdatedConnectRepositoryInput({ value }),
          buttonId: ID.connectButton,
          buttonText: "Connect",
          onClick: Message.ClickedConnect(),
        },
        h,
      ),
      valueRow("result", ID.connectStatus, model.connectStatus, h),
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
          h.ul(
            [h.Id(ID.projectList)],
            model.projects.map((project) => projectButton(project, model, h)),
          ),
          gitHubPanel(model, h),
          chatGPTPanel(model, h),
          connectPanel(model, h),
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
          h.p(
            [h.Class("note")],
            [
              "Cloudflare Access already signed you in. This page asks for no credential, stores none, and calls only this origin.",
            ],
          ),
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
