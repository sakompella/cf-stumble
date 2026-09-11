/// <reference types="@cloudflare/vitest-plugin/types" />

import { expect, test } from "vitest";
import { MainHarnessArtifact } from "../../../src/facet/index.js";
import type { MainHarnessArtifactInput } from "../../../src/facet/index.js";
import { canonicalModuleMap, encodeModuleMap } from "../../../src/supervisor/artifacts/index.js";

const harnessCommit = "5000000000000000000000000000000000000001";

function canonical(input: MainHarnessArtifactInput): MainHarnessArtifactInput {
  const parsed = MainHarnessArtifact.parse(input);

  if (parsed.isErr()) {
    throw new Error(`the test module map must parse: ${parsed.error.code}`);
  }

  return canonicalModuleMap(parsed.value);
}

function moduleMap(
  entryModule: string,
  modules: readonly Readonly<{ name: string; source: string }>[],
): MainHarnessArtifactInput {
  return { harnessCommit, entryModule, modules };
}

const modules = [
  { name: "main.js", source: "export default {};\n" },
  { name: "a-helper.js", source: "export const a = 1;\n" },
  { name: "z-helper.js", source: "export const z = 2;\n" },
];

test("sorts modules by name and keeps the entry module named", () => {
  const map = canonical(moduleMap("main.js", modules));

  expect(map.entryModule).toBe("main.js");
  expect(map.modules.map((module) => module.name)).toEqual([
    "a-helper.js",
    "main.js",
    "z-helper.js",
  ]);
});

test("encodes one module map to the same bytes whatever order it arrived in", () => {
  const forward = canonical(moduleMap("main.js", modules));
  const reversed = canonical(moduleMap("main.js", modules.toReversed()));

  expect(encodeModuleMap(reversed)).toBe(encodeModuleMap(forward));
});

test("separates module maps that differ in a module source", () => {
  const original = canonical(moduleMap("main.js", modules));

  const edited = canonical(
    moduleMap("main.js", [
      { name: "main.js", source: "export default {};\n" },
      { name: "a-helper.js", source: "export const a = 3;\n" },
      { name: "z-helper.js", source: "export const z = 2;\n" },
    ]),
  );

  expect(encodeModuleMap(edited)).not.toBe(encodeModuleMap(original));
});
