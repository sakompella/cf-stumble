import * as Option from "effect/Option";
import { expect, test } from "vitest";
import type { BackendSetting } from "../../../src/backend-setting.js";
import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import { Message } from "../../../src/page/client/message.js";
import { init, update } from "../../../src/page/client/update.js";
import { findById, htmlOf } from "./rendered.js";
import { settled } from "./requests.js";
import { shownText } from "./shown.js";

function pressed(backend: "provider" | "cloudflare"): (id: string) => boolean {
  const html = htmlOf({ ...init().model, maybeBackend: Option.some(backend) });

  return (id) => findById(html, id)?.data?.attrs?.["aria-pressed"] === "true";
}

test("the control marks the chosen backend", () => {
  expect(pressed("cloudflare")(ID.backendCloudflareButton)).toBe(true);
  expect(pressed("cloudflare")(ID.backendProviderButton)).toBe(false);
  expect(pressed("provider")(ID.backendProviderButton)).toBe(true);
});

type Change = Readonly<{
  backend: BackendSetting;
  container: "stopped" | "not-running" | "kept";
  startsOn: BackendSetting;
}>;

function changeTo(change: Change) {
  return settled(update(init().model, Message.ClickedBackend({ backend: change.backend })), () =>
    Promise.resolve(Response.json({ ok: true, ...change })),
  );
}

test.each([
  [
    { backend: "cloudflare", container: "stopped", startsOn: "cloudflare" },
    "stopped the container; the next container starts on Cloudflare",
  ],
  [
    { backend: "cloudflare", container: "not-running", startsOn: "cloudflare" },
    "no container was running; the next container starts on Cloudflare",
  ],
  [
    { backend: "cloudflare", container: "kept", startsOn: "cloudflare" },
    "already selected, nothing changed; the next container starts on Cloudflare",
  ],
  [
    { backend: "provider", container: "stopped", startsOn: "cloudflare" },
    "stopped the container; no provider is connected, so the next container starts on Cloudflare",
  ],
  [
    { backend: "provider", container: "not-running", startsOn: "provider" },
    "no container was running; the next container starts on the provider",
  ],
] as const)("a backend change answered %j shows %s", async (change, wording) => {
  const done = await changeTo(change);

  expect(done.sent).toEqual([
    { method: "POST", path: "/api/workspace/backend", body: { backend: change.backend } },
  ]);
  expect(shownText(done.model, ID.backendResult)).toBe(wording);
});

test("reading the setting at load shows no result, because a read is not an action", () => {
  const loaded = update(init().model, Message.SucceededBackend({ backend: "provider" })).model;

  expect(shownText(loaded, ID.backendResult)).toBe("");
  expect(
    findById(htmlOf(loaded), ID.backendProviderButton)?.data?.attrs?.["aria-pressed"] === "true",
  ).toBe(true);
});
