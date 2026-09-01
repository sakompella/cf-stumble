import { expect, test } from "vitest";

declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { readonly eager: true; readonly query: "?raw"; readonly import: "default" },
    ) => Record<string, string>;
  }
}

const upstreamFiles = import.meta.glob("../../vendor/pi-v0.84.4/UPSTREAM.json", {
  eager: true,
  query: "?raw",
  import: "default",
});

const upstream = Object.values(upstreamFiles).at(0) ?? "";

test("pins the vendored Pi source to v0.84.4", () => {
  expect(upstream).toContain('"tag": "v0.84.4"');
  expect(upstream).toContain('"commit": "b79e4cc834970cca69daebffab7df1da7d1e52c4"');
});
