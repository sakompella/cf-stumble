import * as Option from "effect/Option";
import { expect, test } from "vitest";
import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import { init } from "../../../src/page/client/update.js";
import { findById, htmlOf } from "./rendered.js";

function pressed(backend: "provider" | "cloudflare"): (id: string) => boolean {
  const html = htmlOf({ ...init().model, maybeBackend: Option.some(backend) });

  return (id) => findById(html, id)?.data?.attrs?.["aria-pressed"] === "true";
}

test("the control marks the chosen backend", () => {
  expect(pressed("cloudflare")(ID.backendCloudflareButton)).toBe(true);
  expect(pressed("cloudflare")(ID.backendProviderButton)).toBe(false);
  expect(pressed("provider")(ID.backendProviderButton)).toBe(true);
});
