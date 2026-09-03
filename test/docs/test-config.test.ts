import { expect, test } from "vitest";

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

test("the test Worker configuration differs from production only by name and the AI binding", () => {
  const production = config("wrangler.jsonc");
  const testing = config("wrangler.test.jsonc");

  expect(production).toContain('"ai": { "binding": "AI" }');
  expect(testing).not.toContain('"ai"');
  expect(testing.replace('"cf-stumble-test"', '"cf-stumble"')).toBe(
    production.replace('  "ai": { "binding": "AI" },\n', ""),
  );
});
