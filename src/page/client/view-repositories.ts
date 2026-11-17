import * as Option from "effect/Option";
import type { Html, HtmlBuilder } from "foldkit/html";
import { OWNER_PAGE_CLASSES as CLASS, OWNER_PAGE_IDS as ID } from "../element-ids.js";
import { disconnectPrompt } from "./disconnect-refusals.js";
import { Message } from "./message.js";
import { Disconnect, type Model, type Project } from "./model.js";
import { selectedRepository } from "./selected-repository.js";
import { controlRow, valueRow } from "./view-parts.js";

function confirmation(project: Project, isBusy: boolean, h: HtmlBuilder<Message>): Html {
  return h.div(
    [],
    [
      h.p([h.Id(ID.disconnectPrompt)], [disconnectPrompt(project.displayName)]),
      h.div(
        [h.Class("row")],
        [
          h.button(
            [
              h.Id(ID.disconnectConfirmButton),
              h.Type("button"),
              h.Disabled(isBusy),
              h.OnClick(Message.ConfirmedDisconnect()),
            ],
            ["Yes, disconnect"],
          ),
          h.button(
            [
              h.Id(ID.disconnectCancelButton),
              h.Type("button"),
              h.Disabled(isBusy),
              h.OnClick(Message.CancelledDisconnect()),
            ],
            ["Keep it"],
          ),
        ],
      ),
    ],
  );
}

function control(project: Project, model: Model, h: HtmlBuilder<Message>): Html {
  const { disconnect } = model;

  const isAsking =
    (Disconnect.guards.Confirming(disconnect) || Disconnect.guards.Disconnecting(disconnect)) &&
    disconnect.projectId === project.id;

  return isAsking
    ? confirmation(project, Disconnect.guards.Disconnecting(disconnect), h)
    : h.div(
        [h.Class("row")],
        [
          h.button(
            [h.Id(ID.disconnectButton), h.Type("button"), h.OnClick(Message.ClickedDisconnect())],
            ["Disconnect repository"],
          ),
        ],
      );
}

function statusWording(model: Model): string {
  return Disconnect.match(model.disconnect, {
    Idle: () => "",
    Confirming: () => "",
    Disconnecting: () => "disconnecting",
    Told: ({ wording }) => wording,
  });
}

function disconnectPanel(model: Model, h: HtmlBuilder<Message>): Html {
  return h.div(
    [h.Class("sidebar-panel")],
    [
      h.h3([], ["Disconnect a repository"]),
      ...Option.match(selectedRepository(model), {
        onNone: () => [h.p([h.Class("note")], ["select a connected repository first"])],
        onSome: (project) => [control(project, model, h)],
      }),
      valueRow("result", ID.disconnectStatus, statusWording(model), h),
    ],
  );
}

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

export function projectListView(model: Model, h: HtmlBuilder<Message>): Html {
  return h.ul(
    [h.Id(ID.projectList)],
    model.projects.map((project) => projectButton(project, model, h)),
  );
}

export function connectPanels(model: Model, h: HtmlBuilder<Message>): readonly Html[] {
  return [connectPanel(model, h), disconnectPanel(model, h)];
}
