import { OWNER_PAGE_IDS as ID } from "../../src/page/element-ids.js";
import { HARNESS_THREAD_MARKER } from "../browser-harness/conversations.mjs";
import {
  CHECKED_WORDING,
  CONNECTED_PROJECT_URL,
  HARNESS_PROJECT_ID,
} from "../browser-harness/fixtures.mjs";
import { expect, projectButton, requestsTo, test } from "./fixtures.mjs";

test("selecting the harness project reads its own conversation and stops reading the other", async ({
  owner,
  server,
}) => {
  await projectButton(owner, "harness").click();

  await expect(owner.locator(`#${ID.conversationProject}`)).toHaveText("harness");
  await expect(projectButton(owner, "harness")).toHaveAttribute("aria-current", "true");
  await expect(projectButton(owner, "octocat-hello-world")).not.toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(owner.locator(`#${ID.messageList}`)).toContainText(HARNESS_THREAD_MARKER);
  expect(requestsTo(server, "GET", "/api/projects/harness/events")).toHaveLength(1);
  await expect.poll(() => server.openEventStreams(HARNESS_PROJECT_ID)).toBe(0);
});

test("connecting a repository adds it and keeps the current project", async ({ owner, server }) => {
  await owner.locator(`#${ID.connectButton}`).click();
  await expect(owner.locator(`#${ID.connectStatus}`)).toHaveText("enter a repository url first");
  expect(requestsTo(server, "POST", "/api/projects/connect")).toEqual([]);

  await owner.getByLabel("repository url").fill(CONNECTED_PROJECT_URL);
  await owner.locator(`#${ID.connectButton}`).click();

  await expect(owner.locator(`#${ID.projectListStatus}`)).toHaveText("2 connected");
  expect(requestsTo(server, "POST", "/api/projects/connect").map((r) => r.body)).toEqual([
    { repositoryUrl: CONNECTED_PROJECT_URL },
  ]);
  await expect(projectButton(owner, "octocat-hello-world")).toHaveAttribute("aria-current", "true");
});

test.describe("GitHub connection", () => {
  test("is read from the record at load, and the workspace is asked only on Check again", async ({
    owner,
    server,
  }) => {
    const github = owner.locator(`#${ID.githubState}`);
    await expect(github).toHaveText("connected");
    await expect(owner.locator(`#${ID.githubDetail}`)).toHaveText("octocat (owner-authorization)");
    await expect(owner.locator(`#${ID.githubChecked}`)).toHaveText(CHECKED_WORDING);
    expect(requestsTo(server, "GET", "/api/github/connection")).toHaveLength(1);
    expect(requestsTo(server, "POST", "/api/github/connection/refresh")).toEqual([]);

    await owner.locator(`#${ID.refreshGitHubButton}`).click();

    await expect
      .poll(() => requestsTo(server, "POST", "/api/github/connection/refresh"))
      .toHaveLength(1);
    await expect(github).toHaveText("connected");
  });

  test.describe("awaiting authorization", () => {
    test.use({ scenario: "github-awaiting-authorization" });

    test("shows the code and a safe device link", async ({ owner }) => {
      await expect(owner.locator(`#${ID.githubState}`)).toHaveText("awaiting-authorization");
      await expect(owner.locator(`#${ID.githubDetail}`)).toContainText("WDJB-MJHT");

      const link = owner.locator(`#${ID.githubVerificationLink}`);
      await expect(link).toHaveAttribute("href", "https://github.com/login/device");
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", /noopener/u);
      await expect(link).toHaveAttribute("rel", /noreferrer/u);
    });
  });

  test.describe("disconnected", () => {
    test.use({ scenario: "github-disconnected" });

    test("shows no detail and a link with no address", async ({ owner }) => {
      await expect(owner.locator(`#${ID.githubState}`)).toHaveText("disconnected");
      await expect(owner.locator(`#${ID.githubDetail}`)).toHaveText("");
      await expect(owner.locator(`#${ID.githubVerificationLink}`)).not.toHaveAttribute(
        "href",
        /./u,
      );
    });
  });
});
