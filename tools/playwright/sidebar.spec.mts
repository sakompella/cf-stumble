import type { Page } from "@playwright/test";
import { OWNER_PAGE_IDS as ID } from "../../src/page/element-ids.js";
import { HARNESS_THREAD_MARKER } from "../browser-harness/conversations.mjs";
import {
  CHECKED_WORDING,
  CONNECTED_PROJECT_URL,
  HARNESS_PROJECT_ID,
} from "../browser-harness/fixtures.mjs";
import { expect, projectButton, requestsTo, sendMessage, test } from "./fixtures.mjs";

const PROJECT_PATH = "/api/projects/octocat-hello-world";

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

test("the owner disconnects a repository from the sidebar", async ({ owner, server }) => {
  await expect(projectButton(owner, "octocat-hello-world")).toHaveAttribute("aria-current", "true");
  await owner.locator(`#${ID.disconnectButton}`).click();

  await expect(owner.locator(`#${ID.disconnectPrompt}`)).toContainText("hello-world");
  expect(requestsTo(server, "POST", `${PROJECT_PATH}/disconnect`)).toEqual([]);

  await owner.locator(`#${ID.disconnectConfirmButton}`).click();

  await expect(owner.locator(`#${ID.disconnectStatus}`)).toHaveText("disconnected hello-world");
  await expect(projectButton(owner, "octocat-hello-world")).toHaveCount(0);
  await expect(owner.locator(`#${ID.projectListStatus}`)).toHaveText("no repository connected yet");
  await expect(projectButton(owner, "harness")).toHaveAttribute("aria-current", "true");
  await expect(owner.locator(`#${ID.conversationProject}`)).toHaveText("harness");
  await expect(owner.locator(`#${ID.disconnectButton}`)).toHaveCount(0);
  expect(requestsTo(server, "POST", `${PROJECT_PATH}/disconnect`)).toHaveLength(1);
});

async function anotherTab(owner: Page, url: string): Promise<Page> {
  const tab = await owner.context().newPage();
  await tab.goto(`${url}/`);
  await expect(tab.locator(`#${ID.conversationState}`)).toHaveText("live");

  return tab;
}

test("a repository connected in another tab appears when the owner returns", async ({
  owner,
  server,
}) => {
  const other = await anotherTab(owner, server.url);
  await other.getByLabel("repository url").fill(CONNECTED_PROJECT_URL);
  await other.locator(`#${ID.connectButton}`).click();
  await expect(other.locator(`#${ID.projectListStatus}`)).toHaveText("2 connected");

  await owner.bringToFront();
  await expect(owner.locator(`#${ID.projectListStatus}`)).toHaveText("1 connected");
  await owner.evaluate('window.dispatchEvent(new Event("focus"))');

  await expect(owner.locator(`#${ID.projectListStatus}`)).toHaveText("2 connected");
  await expect(projectButton(owner, "octocat-new-repo")).toBeVisible();
  await expect(projectButton(owner, "octocat-hello-world")).toHaveAttribute("aria-current", "true");
});

test("a repository disconnected in another tab leaves the owner on the harness conversation when the owner returns", async ({
  owner,
  server,
}) => {
  const other = await anotherTab(owner, server.url);
  await other.locator(`#${ID.disconnectButton}`).click();
  await other.locator(`#${ID.disconnectConfirmButton}`).click();
  await expect(other.locator(`#${ID.disconnectStatus}`)).toHaveText("disconnected hello-world");

  await owner.bringToFront();
  await expect(projectButton(owner, "octocat-hello-world")).toHaveAttribute("aria-current", "true");
  await owner.evaluate('document.dispatchEvent(new Event("visibilitychange"))');

  await expect(projectButton(owner, "octocat-hello-world")).toHaveCount(0);
  await expect(projectButton(owner, "harness")).toHaveAttribute("aria-current", "true");
  await expect(owner.locator(`#${ID.conversationProject}`)).toHaveText("harness");
  await expect(owner.locator(`#${ID.messageList}`)).toContainText(HARNESS_THREAD_MARKER);
  await expect(owner.locator(`#${ID.conversationState}`)).toHaveText("live");
  await expect.poll(() => server.openEventStreams(HARNESS_PROJECT_ID)).toBe(0);
});

const LEAVE_AND_RETURN = `
  const setVisibility = (value) => {
    Object.defineProperty(document, "visibilityState", { value, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  setVisibility("hidden");
  setVisibility("visible");
`;

test("leaving the tab reads nothing, and coming back reads once", async ({ owner, server }) => {
  const projectReads = () => requestsTo(server, "GET", "/api/projects").length;
  const before = projectReads();

  await owner.evaluate(LEAVE_AND_RETURN);

  await expect.poll(projectReads).toBe(before + 1);
});

test.describe("a run that is still going", () => {
  test.use({ scenario: "ready-paused", refusedStatuses: [409] });

  test("blocks disconnecting its own project and says why", async ({ owner, server }) => {
    await sendMessage(owner, "Keep working");
    await server.waitForBarrier();

    await owner.locator(`#${ID.disconnectButton}`).click();
    await owner.locator(`#${ID.disconnectConfirmButton}`).click();

    await expect(owner.locator(`#${ID.disconnectStatus}`)).toHaveText(
      "not disconnected: A run is active. Cancel it or wait until it ends.",
    );
    await expect(projectButton(owner, "octocat-hello-world")).toBeVisible();
    server.release();
  });
});

test.describe("GitHub connection", () => {
  test("is read from the record at load, and the workspace is asked only on Check again", async ({
    owner,
    server,
  }) => {
    const github = owner.locator(`#${ID.githubState}`);
    await expect(github).toHaveText("connected");
    await expect(owner.locator(`#${ID.githubDetail}`)).toHaveText("octocat (device-authorization)");
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
