import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { Scene } from "foldkit/test";
import { expect, test } from "vitest";
import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import { Message } from "../../../src/page/client/message.js";
import { FollowTranscript } from "../../../src/page/client/mount.js";
import { init, update } from "../../../src/page/client/update.js";
import { view } from "../../../src/page/client/view.js";

type Rendered = NonNullable<ReturnType<typeof view>>;

function findById(node: Rendered | string, id: string): Rendered | undefined {
  if (Predicate.isString(node)) return undefined;

  return node.data?.props?.["id"] === id
    ? node
    : (node.children ?? []).map((child) => findById(child, id)).find(Predicate.isNotUndefined);
}

function pressed(backend: "provider" | "cloudflare"): (id: string) => boolean {
  let html: Rendered | undefined;

  Scene.scene(
    { update, view },
    Scene.given({ ...init().model, maybeBackend: Option.some(backend) }),
    Scene.tap((simulation) => {
      html = simulation.html;
    }),
    Scene.Mount.resolve(FollowTranscript, Message.CompletedFollowTranscript()),
  );

  return (id) =>
    (html === undefined ? undefined : findById(html, id))?.data?.attrs?.["aria-pressed"] === "true";
}

test("the control marks the chosen backend", () => {
  expect(pressed("cloudflare")(ID.backendCloudflareButton)).toBe(true);
  expect(pressed("cloudflare")(ID.backendProviderButton)).toBe(false);
  expect(pressed("provider")(ID.backendProviderButton)).toBe(true);
});

test("clicking asks for the change and the answer becomes the chosen backend", () => {
  const clicked = update(init().model, Message.ClickedBackend({ backend: "cloudflare" }));

  expect(clicked.commands?.length).toBe(1);

  const done = update(clicked.model, Message.SucceededBackend({ backend: "cloudflare" }));

  expect(done.model.maybeBackend).toEqual(Option.some("cloudflare"));
  expect(done.model.backendResult).toBe("");
});
