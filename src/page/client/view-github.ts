import type { Html, HtmlBuilder } from "foldkit/html";
import { OWNER_PAGE_IDS as ID } from "../element-ids.js";
import { GitHubConnection, gitHubDetail, gitHubWording } from "./github.js";
import { Message } from "./message.js";
import type { Model } from "./model.js";
import { valueRow } from "./view-parts.js";

type Control = Readonly<{ id: string; message: Message; label: string }>;

const AUTHORIZE: Control = {
  id: ID.authorizeButton,
  message: Message.ClickedAuthorize({ endpoint: "POST /api/github/authorization" }),
  label: "Authorize GitHub",
};

const COMPLETE: Control = {
  id: ID.completeAuthorizationButton,
  message: Message.ClickedAuthorize({ endpoint: "POST /api/github/authorization/complete" }),
  label: "I authorized it",
};

const CHECK: Control = {
  id: ID.refreshGitHubButton,
  message: Message.ClickedRefreshGitHub(),
  label: "Check again",
};

function controls(connection: GitHubConnection): readonly Control[] {
  return GitHubConnection.match(connection, {
    Unknown: () => [AUTHORIZE, CHECK],
    Disconnected: () => [AUTHORIZE, CHECK],
    ReconnectRequired: () => [AUTHORIZE, CHECK],
    AwaitingAuthorization: () => [AUTHORIZE, COMPLETE, CHECK],
    Connected: () => [CHECK],
    ToolingMissing: () => [CHECK],
  });
}

function deviceLink(connection: GitHubConnection, h: HtmlBuilder<Message>): readonly Html[] {
  return GitHubConnection.matchOrElse(
    connection,
    {
      AwaitingAuthorization: ({ verificationUri }) => [
        h.p(
          [h.Class("row")],
          [
            h.a(
              [
                h.Id(ID.githubVerificationLink),
                h.Href(verificationUri),
                h.Rel("noreferrer noopener"),
                h.Target("_blank"),
              ],
              [verificationUri],
            ),
          ],
        ),
      ],
    },
    () => [],
  );
}

export function gitHubPanel(model: Model, h: HtmlBuilder<Message>): Html {
  const { connection, checked, result } = model.github;

  return h.div(
    [h.Class("sidebar-panel")],
    [
      h.h3([], ["GitHub"]),
      valueRow("connection", ID.githubState, gitHubWording(connection), h),
      valueRow("detail", ID.githubDetail, gitHubDetail(connection), h),
      valueRow("last checked", ID.githubChecked, checked, h),
      valueRow("result", ID.githubResult, result, h),
      ...deviceLink(connection, h),
      h.div(
        [h.Class("row")],
        controls(connection).map(({ id, message, label }) =>
          h.button([h.Id(id), h.Type("button"), h.OnClick(message)], [label]),
        ),
      ),
    ],
  );
}
