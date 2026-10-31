import { expect, test } from "vitest";
import wranglerConfig from "../../wrangler.config.js";
import { parsedConfig } from "./wrangler-files.js";

const BUILDS_THE_PAGE = { build: { command: "pnpm run build:page" } };

test("every Worker build builds the owner page's script first", () => {
  expect(wranglerConfig).toMatchObject(BUILDS_THE_PAGE);
  expect(parsedConfig("wrangler.jsonc")).toMatchObject(BUILDS_THE_PAGE);
  expect(parsedConfig("wrangler.test.jsonc")).toMatchObject(BUILDS_THE_PAGE);
});
