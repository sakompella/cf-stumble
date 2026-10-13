import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { Scene } from "foldkit/test";
import { expect, test } from "vitest";
import { OWNER_PAGE_ELEMENT_IDS } from "../../../src/page/element-ids.js";
import { Message } from "../../../src/page/client/message.js";
import { FollowTranscript } from "../../../src/page/client/mount.js";
import type { ChatGPTConnection, Model } from "../../../src/page/client/model.js";
import { init, update } from "../../../src/page/client/update.js";
import { view } from "../../../src/page/client/view.js";

/**
 * The browser harness and the owner find elements by the identifiers in `element-ids.ts`. An
 * identifier the views do not render would make a harness wait time out rather than fail with a
 * reason, so this checks every one against the rendered tree.
 */

type Rendered = NonNullable<ReturnType<typeof view>>;

function renderedIds(node: Rendered | string): readonly string[] {
  if (Predicate.isString(node)) {
    return [];
  }

  const id: unknown = node.data?.props?.["id"];
  const own = Predicate.isString(id) ? [id] : [];

  return [...own, ...(node.children ?? []).flatMap((child) => renderedIds(child))];
}

function shownWithDiagnostics(): Model {
  return update(
    init().model,
    Message.SucceededSubmit({
      label: "2",
      epoch: "4",
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
  // The ChatGPT control offers disconnecting, or a sign-in, or neither, so no one state renders
  // every identifier.
  const pages = [
    shownWithDiagnostics(),
    withChatGPT({
      connection: "not connected",
      isConnected: false,
      maybeLogin: Option.some({ attemptId: "a", authorizeUrl: "https://auth.example/authorize" }),
    }),
    withChatGPT({ connection: "connected", isConnected: true, maybeLogin: Option.none() }),
  ].map((model) => idsRendered(model));

  for (const id of OWNER_PAGE_ELEMENT_IDS) {
    const counts = pages.map((ids) => ids.filter((rendered) => rendered === id).length);

    expect(Math.max(...counts), id).toBe(1);
  }
});
