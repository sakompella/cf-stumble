import { AuthorizeGitHub, RefreshGitHub } from "./commands.js";
import { GitHubConnection, type GitHub } from "./github.js";
import type { Model } from "./model.js";
import { clearError, withError, type Handlers } from "./update-shared.js";

export const INITIAL_GITHUB: GitHub = {
  connection: GitHubConnection.Unknown(),
  checked: "",
  result: "",
};

function asking(model: Model): Model {
  return { ...clearError(model), github: { ...model.github, result: "asking GitHub" } };
}

export function gitHubHandlers(
  model: Model,
): Handlers<
  | "ClickedAuthorize"
  | "ClickedRefreshGitHub"
  | "SucceededGitHub"
  | "RejectedGitHub"
  | "FailedGitHub"
> {
  return {
    ClickedAuthorize: ({ endpoint }) => ({
      model: asking(model),
      commands: [AuthorizeGitHub({ endpoint })],
    }),
    ClickedRefreshGitHub: () => ({ model: asking(model), commands: [RefreshGitHub()] }),
    SucceededGitHub: ({ reading }) => ({ model: { ...model, github: { ...reading, result: "" } } }),
    RejectedGitHub: ({ wording }) => ({
      model: { ...model, github: { ...model.github, result: wording } },
    }),
    FailedGitHub: ({ detail }) => ({
      model: {
        ...withError(model, "the GitHub request", detail),
        github: { ...model.github, result: "request failed" },
      },
    }),
  };
}
