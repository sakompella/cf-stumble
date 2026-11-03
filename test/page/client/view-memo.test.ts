import * as Predicate from "effect/Predicate";
import { Scene } from "foldkit/test";
import { expect, test } from "vitest";
import type { AgentEvent } from "../../../src/page/client/agent-event.js";
import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { FollowTranscript } from "../../../src/page/client/mount.js";
import { init, update } from "../../../src/page/client/update.js";
import { view } from "../../../src/page/client/view.js";

type Rendered = NonNullable<ReturnType<typeof view>>;

function findById(node: Rendered | string, id: string): Rendered | undefined {
  if (Predicate.isString(node)) {
    return undefined;
  }

  return node.data?.props?.["id"] === id
    ? node
    : (node.children ?? []).map((child) => findById(child, id)).find(Predicate.isNotUndefined);
}

function received(model: Model, event: AgentEvent): Message {
  return Message.ReceivedEvent({ streamId: model.eventsStreamId, event });
}

const listed = update(
  init().model,
  Message.SucceededFetchProjects({
    projects: [{ id: "repo", displayName: "repo", isHarness: false, location: "/workspace/repo" }],
  }),
).model;

const withHistory = update(
  listed,
  received(listed, {
    type: "snapshot",
    entries: [
      {
        id: 1,
        kind: "pi.test",
        model: [
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
        ],
      },
    ],
    tools: [],
    inbox: [],
  }),
).model;

function delta(text: string): Message {
  return received(withHistory, {
    type: "message_update",
    changes: [{ type: "text_delta", contentIndex: 0, delta: text }],
  });
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
    Scene.Subscription.emit(
      received(withHistory, {
        type: "message_start",
        message: { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "" },
      }),
    ),
    Scene.Subscription.emit(delta("Hel")),
    Scene.tap((simulation) => {
      before = rows(simulation);
    }),
    Scene.Subscription.emit(delta("lo")),
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
