import { expect, test } from "vitest";
import wranglerConfig from "../../wrangler.config.js";
import { parsedConfig } from "./wrangler-files.js";

/**
 * The owner page's script is a generated module that Git ignores, so every way of building the
 * Worker must build it first. `cf build` and `cf deploy` read `wrangler.config.ts`; `wrangler
 * deploy` and the Deploy to Cloudflare flow read `wrangler.jsonc`, and `wrangler.test.jsonc` must
 * match that file apart from its name and AI binding.
 */

const BUILDS_THE_PAGE = { build: { command: "pnpm run build:page" } };

test("every Worker build builds the owner page's script first", () => {
  expect(wranglerConfig).toMatchObject(BUILDS_THE_PAGE);
  expect(parsedConfig("wrangler.jsonc")).toMatchObject(BUILDS_THE_PAGE);
  expect(parsedConfig("wrangler.test.jsonc")).toMatchObject(BUILDS_THE_PAGE);
});
