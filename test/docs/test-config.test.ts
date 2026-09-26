import { expect, test } from "vitest";
import { isRecord } from "../../src/routes/json.js";

/**
 * Declaring Workers AI opens a remote connection for every Workers test, so one network failure
 * can fail unrelated tests. Tests therefore load a copy of the Worker configuration without that
 * binding, and this check keeps the copy from drifting in any other way.
 *
 * Vite resolves the glob at build time, so this reads no filesystem and runs in workerd.
 */
declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { readonly eager: true; readonly query: "?raw"; readonly import: "default" },
    ) => Record<string, string>;
  }
}

const configs = import.meta.glob("../../wrangler*.jsonc", {
  eager: true,
  query: "?raw",
  import: "default",
});

function withoutComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
    .trim();
}

function config(name: string): string {
  const found = Object.entries(configs).find(([path]) => path.endsWith(name));

  if (found === undefined) {
    throw new Error(`missing ${name}`);
  }

  return withoutComments(found[1]);
}

type WranglerContainer = Readonly<{ instance_type?: unknown }>;

type WranglerConfig = Readonly<{
  cache?: Readonly<{ enabled?: boolean }>;
  containers?: readonly WranglerContainer[];
}>;

function isWranglerConfig(value: unknown): value is WranglerConfig {
  if (!isRecord(value)) return false;

  const cache = value.cache;
  const containers = value.containers;

  return (
    (cache === undefined ||
      (isRecord(cache) && (cache.enabled === undefined || typeof cache.enabled === "boolean"))) &&
    (containers === undefined ||
      (Array.isArray(containers) && containers.every((container) => isRecord(container))))
  );
}

function parsedConfig(name: string): WranglerConfig {
  const json = config(name).replaceAll(/,\s*([}\]])/gu, "$1");
  const parsed: unknown = JSON.parse(json);

  if (!isWranglerConfig(parsed)) {
    throw new Error(`invalid ${name}`);
  }

  return parsed;
}

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
