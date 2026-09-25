import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import { MainHarnessArtifact } from "../../../src/facet/index.js";
import type { MainHarnessArtifactInput } from "../../../src/facet/index.js";
import { canonicalModuleMap, encodeModuleMap } from "../../../src/supervisor/artifacts/index.js";

const harnessCommit = "6000000000000000000000000000000000000001";

const moduleName = gs
  .text({ alphabet: "abcdefg", minSize: 1, maxSize: 4 })
  .map((stem) => `${stem}.js`);

const moduleMaps = gs
  .maps(moduleName, gs.text({ maxSize: 12 }), { minSize: 1, maxSize: 6 })
  .map((entries) => [...entries].map(([name, source]) => ({ name, source })));

function canonical(input: MainHarnessArtifactInput): MainHarnessArtifactInput {
  const parsed = MainHarnessArtifact.parse(input);

  if (parsed.isErr()) {
    throw new Error(`the generated module map must parse: ${parsed.error.code}`);
  }

  return canonicalModuleMap(parsed.value);
}

function rotated<T>(values: readonly T[], by: number): readonly T[] {
  const offset = by % values.length;

  return [...values.slice(offset), ...values.slice(0, offset)];
}

test("canonicalizes one module map to the same bytes whatever order it arrived in", () => {
  hegel.test((tc) => {
    const modules = tc.draw(moduleMaps);
    const entryModule = modules[0]?.name ?? "";
    const by = tc.draw(gs.integers({ minValue: 0, maxValue: modules.length }));

    const first = canonical({ harnessCommit, entryModule, modules });

    const second = canonical({ harnessCommit, entryModule, modules: rotated(modules, by) });

    expect(encodeModuleMap(second)).toBe(encodeModuleMap(first));
  });
});

test("distinguishes module maps when a source or entry module changes", () => {
  hegel.test((tc) => {
    const modules = tc.draw(moduleMaps);
    const entryModule = modules[0]?.name ?? "";
    const edit = tc.draw(gs.sampledFrom(["rotation", "source", "entry"] as const));
    let otherModules = modules;
    let otherEntryModule = entryModule;
    let encodingsShouldMatch = true;

    if (edit === "rotation") {
      const by = tc.draw(gs.integers({ minValue: 0, maxValue: modules.length }));
      otherModules = [...rotated(modules, by)];
    } else if (edit === "source") {
      const index = tc.draw(gs.integers({ minValue: 0, maxValue: modules.length - 1 }));
      const suffix = tc.draw(gs.characters());
      otherModules = modules.map((module, moduleIndex) =>
        moduleIndex === index ? { ...module, source: module.source + suffix } : module,
      );
      encodingsShouldMatch = false;
    } else if (modules.length > 1) {
      otherEntryModule = modules[1]?.name ?? entryModule;
      encodingsShouldMatch = false;
    } else {
      const suffix = tc.draw(gs.characters());
      otherModules = [{ ...modules[0]!, source: modules[0]!.source + suffix }];
      encodingsShouldMatch = false;
    }

    const first = canonical({ harnessCommit, entryModule, modules });

    const second = canonical({
      harnessCommit,
      entryModule: otherEntryModule,
      modules: otherModules,
    });

    expect(encodeModuleMap(second) === encodeModuleMap(first)).toBe(encodingsShouldMatch);
  });
});

test("keeps the canonical encoding stable when it is canonicalized again", () => {
  hegel.test((tc) => {
    const modules = tc.draw(moduleMaps);
    const entryModule = modules[0]?.name ?? "";

    const once = canonical({ harnessCommit, entryModule, modules });
    const twice = canonical(once);

    expect(encodeModuleMap(twice)).toBe(encodeModuleMap(once));
    expect(twice.entryModule).toBe(entryModule);
  });
});
