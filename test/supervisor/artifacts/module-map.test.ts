import { expect, test } from "vitest";
import type { MainHarnessArtifactInput } from "../../../src/facet/artifact.js";
import { encodeModuleMap } from "../../../src/supervisor/artifacts/module-map.js";
import { parsedArtifact } from "../../facet/fixture.js";

const harnessCommit = "5000000000000000000000000000000000000001";

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

test("separates module maps that differ in a module source", () => {
  const original = parsedArtifact(moduleMap("main.js", modules));

  const edited = parsedArtifact(
    moduleMap("main.js", [
      { name: "main.js", source: "export default {};\n" },
      { name: "a-helper.js", source: "export const a = 3;\n" },
      { name: "z-helper.js", source: "export const z = 2;\n" },
    ]),
  );

  expect(encodeModuleMap(edited)).not.toBe(encodeModuleMap(original));
});
