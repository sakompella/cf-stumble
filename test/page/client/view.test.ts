import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { expect, test } from "vitest";
import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { init, update } from "../../../src/page/client/update.js";
import { findById, htmlOf, textOf, type Rendered } from "./rendered.js";
import { entryItem, pageShowing, running, withChatGPT } from "./views.js";

function renderedIds(node: Rendered | string): readonly string[] {
  if (Predicate.isString(node)) {
    return [];
  }

  const id: unknown = node.data?.props?.["id"];
  const own = Predicate.isString(id) ? [id] : [];

  return [...own, ...(node.children ?? []).flatMap((child) => renderedIds(child))];
}

function textsRendered(model: Model, ids: readonly string[]): readonly string[] {
  const html = htmlOf(model);

  return ids.map((id) => textOf(findById(html, id) ?? ""));
}

function shownWithDiagnostics(): Model {
  return update(
    init().model,
    Message.SucceededSubmit({
      label: 2,
      epoch: 4,
      preparation: "rejected: build-failed",
      maybeDiagnostics: Option.some("stderr:\nerror"),
    }),
  ).model;
}

function idsRendered(model: Model): readonly string[] {
  return renderedIds(htmlOf(model));
}

test("the page renders every stable element id, and none twice", () => {
  const pages = [
    shownWithDiagnostics(),
    withChatGPT({
      connection: { state: "disconnected" },
      login: { attemptId: "a", authorizeUrl: "https://auth.example/authorize" },
      model: "gpt",
    }),
    withChatGPT({ connection: { state: "connected" }, login: null, model: "gpt" }),
    update(
      init().model,
      Message.SucceededFetchStatus({
        reading: {
          maybeActive: Option.some({ label: 1, harnessCommit: "abc", status: "ready" }),
          epoch: 3,
          maybeMainAhead: Option.some(2),
        },
      }),
    ).model,
  ].map((model) => idsRendered(model));

  for (const id of Object.values(ID)) {
    const counts = pages.map((ids) => ids.filter((rendered) => rendered === id).length);

    expect(Math.max(...counts), id).toBe(1);
  }
});

test("a failed activation does not show the effect of an earlier success", () => {
  const activated = update(
    init().model,
    Message.SucceededControl({ kind: "activate", sentEpoch: 3, effect: "activated" }),
  ).model;

  const failed = update(
    activated,
    Message.FailedControl({ kind: "activate", sentEpoch: 3, detail: "offline" }),
  ).model;

  const ids = [ID.activateStatus, ID.activateEffect];

  expect(textsRendered(activated, ids)).toEqual(["ok", "activated"]);
  expect(textsRendered(failed, ids)).toEqual(["request failed", ""]);
});

test("a new submission or refused activation does not keep an earlier attempt's result", () => {
  const submitted = shownWithDiagnostics();
  const submitting = update(submitted, Message.ClickedSubmitCandidate()).model;

  const resubmitting = update(
    update(submitted, Message.UpdatedCandidateCommitInput({ value: "abc" })).model,
    Message.ClickedSubmitCandidate(),
  ).model;

  const submitIds = [ID.submitStatus, ID.submitGenerationLabel, ID.submitEpoch];

  expect(textsRendered(submitted, submitIds)).toEqual(["ok", "2", "4"]);
  expect(textsRendered(submitting, submitIds)).toEqual(["enter a harness commit first", "", ""]);
  expect(textsRendered(resubmitting, submitIds)).toEqual(["running", "", ""]);

  const refused = update(
    update(
      init().model,
      Message.SucceededControl({ kind: "activate", sentEpoch: 3, effect: "activated" }),
    ).model,
    Message.RejectedControl({ kind: "activate", sentEpoch: 3, wording: "rejected: stale-epoch" }),
  ).model;

  expect(
    textsRendered(refused, [ID.activateStatus, ID.activateSentEpoch, ID.activateEffect]),
  ).toEqual(["rejected: stale-epoch", "3", ""]);
});

function classesOf(node: Rendered | string): readonly string[] {
  if (Predicate.isString(node)) {
    return [];
  }

  return Object.keys(node.data?.class ?? {}).flatMap((name) => name.split(" "));
}

function modelShowingToolOutput(output: string): Model {
  return pageShowing(
    running({
      items: [
        entryItem(1, {
          role: "assistant",
          content: [{ type: "toolCall", id: "t", name: "read", arguments: { path: "a" } }],
          stopReason: "toolUse",
        }),
      ],
      tools: [{ callId: "t", name: "read", status: "running", output }],
    }),
  );
}

function diffLinesRendered(output: string): readonly (readonly [string, readonly string[]])[] {
  const collect = (node: Rendered | string): readonly (readonly [string, readonly string[]])[] =>
    Predicate.isString(node)
      ? []
      : [
          ...(classesOf(node).includes("diff-line")
            ? [[textOf(node).trimEnd(), classesOf(node)] as const]
            : []),
          ...(node.children ?? []).flatMap((child) => collect(child)),
        ];

  return collect(htmlOf(modelShowingToolOutput(output)));
}

test("a tool's unified diff output shows headers, additions and removals in their own styles", () => {
  const rendered = diffLinesRendered("diff --git a/f b/f\n@@ -1,2 +1,2 @@\n same\n-old\n+new");
  const kindOf = (line: string) => rendered.find(([text]) => text === line)?.[1] ?? [];

  expect(kindOf("@@ -1,2 +1,2 @@")).toContain("hunk");
  expect(kindOf("-old")).toContain("removed");
  expect(kindOf("+new")).toContain("added");
  expect(kindOf(" same")).not.toContain("hunk");
  expect(kindOf(" same")).not.toContain("added");
  expect(kindOf(" same")).not.toContain("removed");
});

test("output that is not a diff renders as plain text, without diff lines", () => {
  expect(diffLinesRendered("-just a list\n+of things")).toEqual([]);
});
