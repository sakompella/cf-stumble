import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { Scene } from "foldkit/test";
import { expect, test } from "vitest";
import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import { Message } from "../../../src/page/client/message.js";
import { FollowTranscript } from "../../../src/page/client/mount.js";
import type { ChatGPTConnection, Model } from "../../../src/page/client/model.js";
import { init, update } from "../../../src/page/client/update.js";
import { view } from "../../../src/page/client/view.js";

type Rendered = NonNullable<ReturnType<typeof view>>;

function renderedIds(node: Rendered | string): readonly string[] {
  if (Predicate.isString(node)) {
    return [];
  }

  const id: unknown = node.data?.props?.["id"];
  const own = Predicate.isString(id) ? [id] : [];

  return [...own, ...(node.children ?? []).flatMap((child) => renderedIds(child))];
}

function textOf(node: Rendered | string): string {
  return Predicate.isString(node)
    ? node
    : (node.text ?? (node.children ?? []).map(textOf).join(""));
}

function findById(node: Rendered | string, id: string): Rendered | undefined {
  if (Predicate.isString(node)) {
    return undefined;
  }

  return node.data?.props?.["id"] === id
    ? node
    : (node.children ?? []).map((child) => findById(child, id)).find(Predicate.isNotUndefined);
}

function textsRendered(model: Model, ids: readonly string[]): readonly string[] {
  let texts: readonly string[] = [];

  Scene.scene(
    { update, view },
    Scene.given(model),
    Scene.tap((simulation) => {
      texts = ids.map((id) => textOf(findById(simulation.html, id) ?? ""));
    }),
    Scene.Mount.resolve(FollowTranscript, Message.CompletedFollowTranscript()),
  );

  return texts;
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
  let ids: readonly string[] = [];

  Scene.scene(
    { update, view },
    Scene.given(model),
    Scene.tap((simulation) => {
      ids = renderedIds(simulation.html);
    }),
    Scene.Mount.resolve(FollowTranscript, Message.CompletedFollowTranscript()),
  );

  return ids;
}

function withChatGPT(chatgpt: ChatGPTConnection): Model {
  return update(init().model, Message.SucceededChatGPT({ chatgpt })).model;
}

test("the page renders every stable element id, and none twice", () => {
  const pages = [
    shownWithDiagnostics(),
    withChatGPT({
      connection: "not connected",
      isConnected: false,
      maybeLogin: Option.some({ attemptId: "a", authorizeUrl: "https://auth.example/authorize" }),
    }),
    withChatGPT({ connection: "connected", isConnected: true, maybeLogin: Option.none() }),
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
