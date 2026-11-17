import * as Option from "effect/Option";
import { expect, test } from "vitest";
import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { init, update } from "../../../src/page/client/update.js";
import { settled } from "./requests.js";
import { answering, BEFORE, HARNESS, loadedWith, OTHER, REPOSITORY } from "./server-answers.js";
import { promptShown, rowsShown, shownText, streamShown } from "./shown.js";
import { acquired, entryItem, received, viewing } from "./views.js";

function after(start: Model, messages: readonly Message[]): Model {
  return messages.reduce((model, message) => update(model, message).model, start);
}

test("returning to the page shows what another tab changed: the repository list and the generation", async () => {
  const loaded = await loadedWith(BEFORE);

  expect(shownText(loaded, ID.projectListStatus)).toBe("1 connected");
  expect(shownText(loaded, ID.activeGenerationLabel)).toBe("1");

  const returned = update(loaded, Message.ReturnedToPage());

  expect(shownText(returned.model, ID.projectListStatus), "no flicker while it reads").toBe(
    "1 connected",
  );

  const done = await settled(
    returned,
    answering({ projects: [REPOSITORY, OTHER, HARNESS], label: 2, chatgpt: "connected" }),
  );

  expect(shownText(done.model, ID.projectListStatus)).toBe("2 connected");
  expect(shownText(done.model, ID.activeGenerationLabel)).toBe("2");
  expect(done.model.projects.map((project) => project.id)).toEqual(["repo", "other", "harness"]);
  expect(done.model.maybeProjectId).toEqual(Option.some("repo"));
  expect(done.sent.map((request) => `${request.method} ${request.path}`).toSorted()).toEqual([
    "GET /api/chatgpt/connection",
    "GET /api/github/connection",
    "GET /api/projects",
    "GET /api/status",
    "GET /api/workspace/backend",
  ]);
});

test("a repository disconnected elsewhere leaves the first listed project selected, with an empty conversation and none of the old draft", () => {
  const listedOther = { id: "other", displayName: "new-repo", isHarness: false, location: "x" };

  const repo = { id: "repo", displayName: "hello-world", isHarness: false, location: "y" };

  const harness = { id: "harness", displayName: "harness", isHarness: true, location: "z" };

  const listed = after(init().model, [
    Message.SucceededFetchProjects({ projects: [repo, listedOther, harness] }),
    Message.UpdatedPrompt({ value: "draft for repo" }),
    Message.ClickedProject({ projectId: "other" }),
  ]);

  const reading = update(listed, acquired(listed)).model;

  expect(reading.maybeProjectId).toEqual(Option.some("other"));
  expect(promptShown(reading)).toBe("");

  const chatting = after(reading, [
    received(reading, viewing({ items: [entryItem(1, { role: "user", content: "hello" })] })),
    Message.UpdatedPrompt({ value: "draft for other" }),
  ]);

  expect(rowsShown(chatting)).toEqual([{ who: "you", text: "hello" }]);

  const gone = update(
    chatting,
    Message.SucceededFetchProjects({ projects: [repo, harness] }),
  ).model;

  expect(gone.maybeProjectId).toEqual(Option.some("repo"));
  expect(shownText(gone, ID.conversationProject)).toBe("hello-world");
  expect(rowsShown(gone)).toEqual([]);
  expect(streamShown(gone)).toBe("reading");
  expect(promptShown(gone)).toBe("draft for repo");
  expect(gone.drafts).toEqual({});
  expect(gone.eventsStreamId).toBeGreaterThan(chatting.eventsStreamId);
});
