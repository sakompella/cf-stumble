import { expect, test } from "vitest";
import { config, parsedConfig } from "./wrangler-files.js";

test("the test Worker configuration differs from production only by name and the AI binding", () => {
  const production = config("wrangler.jsonc");
  const testing = config("wrangler.test.jsonc");

  expect(production).toContain('"ai": { "binding": "AI" }');
  expect(testing).not.toContain('"ai"');
  expect(testing.replace('"cf-stumble-test"', '"cf-stumble"')).toBe(
    production.replace('  "ai": { "binding": "AI" },\n', ""),
  );
});

test("Workers Cache is explicitly disabled in both configurations", () => {
  expect(parsedConfig("wrangler.jsonc").cache?.enabled).toBe(false);
  expect(parsedConfig("wrangler.test.jsonc").cache?.enabled).toBe(false);
});

test("workspace containers use the checked workload size", () => {
  for (const name of ["wrangler.jsonc", "wrangler.test.jsonc"]) {
    expect(parsedConfig(name).containers?.[0]?.instance_type).toBe("standard-3");
  }
});
