import { Scene } from "foldkit/test";
import { expect, test } from "vitest";
import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import { Message } from "../../../src/page/client/message.js";
import { FollowTranscript } from "../../../src/page/client/mount.js";
import { init, update } from "../../../src/page/client/update.js";
import { view } from "../../../src/page/client/view.js";
import { findById, type Rendered } from "./rendered.js";
import { entryItem, received, running, streaming, viewing } from "./views.js";

const listed = update(
  init().model,
  Message.SucceededFetchProjects({
    projects: [{ id: "repo", displayName: "repo", isHarness: false, location: "/workspace/repo" }],
  }),
).model;

const history = [
  entryItem(
    1,
    { role: "user", content: "show the diff" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Here is **the** diff." },
        { type: "toolCall", id: "t", name: "bash", arguments: { command: "git diff" } },
      ],
      stopReason: "toolUse",
    },
    {
      role: "toolResult",
      toolCallId: "t",
      toolName: "bash",
      content: [{ type: "text", text: "diff --git a/f b/f\n@@ -1 +1 @@\n-old\n+new" }],
      isError: false,
    },
  ),
];

const withHistory = update(listed, received(listed, viewing({ items: history }))).model;

function streamed(text: string): Message {
  return received(withHistory, running({ items: history, maybePartial: streaming(text) }));
}

function rows(simulation: Readonly<{ html: Rendered }>): readonly (Rendered | string)[] {
  return findById(simulation.html, ID.messageList)?.children ?? [];
}

test("editing the prompt reuses the rendered transcript instead of building it again", () => {
  let before: Rendered | undefined;
  let after: Rendered | undefined;

  Scene.scene(
    { update, view },
    Scene.given(withHistory),
    Scene.Mount.resolve(FollowTranscript, Message.CompletedFollowTranscript()),
    Scene.tap((simulation) => {
      before = findById(simulation.html, ID.messageList);
    }),
    Scene.type(`#${ID.promptInput}`, "next question"),
    Scene.tap((simulation) => {
      after = findById(simulation.html, ID.messageList);
    }),
  );

  expect(before).toBeDefined();
  expect(after).toBe(before);
});

test("streaming a reply reuses the rendered rows that did not change", () => {
  let before: readonly (Rendered | string)[] = [];
  let after: readonly (Rendered | string)[] = [];
  Scene.scene(
    { update, view },
    Scene.given(withHistory),
    Scene.Mount.resolve(FollowTranscript, Message.CompletedFollowTranscript()),
    Scene.Subscription.emit(streamed("")),
    Scene.Subscription.emit(streamed("Hel")),
    Scene.tap((simulation) => {
      before = rows(simulation);
    }),
    Scene.Subscription.emit(streamed("Hello")),
    Scene.tap((simulation) => {
      after = rows(simulation);
    }),
  );

  expect(before.length).toBeGreaterThan(3);
  expect(after).toHaveLength(before.length);

  for (const [index, row] of after.slice(0, -1).entries()) {
    expect(row).toBe(before[index]);
  }

  expect(after.at(-1)).not.toBe(before.at(-1));
});
