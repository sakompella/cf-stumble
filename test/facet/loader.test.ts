/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { loadMainFacet } from "../../src/facet/index.js";
import type { MainHarnessArtifactInput } from "../../src/facet/index.js";

function artifact(
  harnessCommit: string,
  entryModule: string,
  modules: MainHarnessArtifactInput["modules"],
): MainHarnessArtifactInput {
  return { harnessCommit, entryModule, modules };
}

function loaderWithRecordedNames(names: string[]): WorkerLoader {
  return {
    get(name, getCode) {
      if (name !== null) {
        names.push(name);
      }

      return env.LOADER.get(name, getCode);
    },
    load(code) {
      return env.LOADER.load(code);
    },
  };
}

async function responseText(worker: WorkerStub): Promise<string> {
  const response = await worker.getEntrypoint().fetch(new Request("https://cf-stumble.test/"));
  return response.text();
}

function facetModule(response: string, imports = ""): string {
  return `
import { DurableObject } from "cloudflare:workers";
${imports}
export class MainFacet extends DurableObject {
  fetch() {
    return new Response(${response});
  }
}

export default {
  fetch() {
    return new Response(${response});
  },
};
`;
}

afterEach(async () => {
  await reset();
});

test("loads a multi-module main harness whose entry module uses an imported value", async () => {
  const loadedHarness = loadMainFacet(
    env.LOADER,
    artifact("0123456789abcdef0123456789abcdef01234567", "main.js", [
      {
        name: "main.js",
        source: facetModule("responseText", 'import { responseText } from "./response.js";'),
      },
      {
        name: "response.js",
        source: 'export const responseText = "from an imported module";',
      },
    ]),
  );

  expect(loadedHarness.isOk()).toBe(true);
  if (loadedHarness.isErr()) {
    return;
  }

  expect(await responseText(loadedHarness.value.worker)).toBe("from an imported module");
});

test("loads a one-module main harness through the artifact loader", async () => {
  const loadedHarness = loadMainFacet(
    env.LOADER,
    artifact("1123456789abcdef0123456789abcdef01234567", "main.js", [
      {
        name: "main.js",
        source: facetModule('"from one module"'),
      },
    ]),
  );

  expect(loadedHarness.isOk()).toBe(true);
  if (loadedHarness.isErr()) {
    return;
  }

  expect(await responseText(loadedHarness.value.worker)).toBe("from one module");
});

test("uses each labeled SHA-1 or SHA-256 harness commit as the Worker Loader name", async () => {
  const loaderNames: string[] = [];
  const loader = loaderWithRecordedNames(loaderNames);
  const firstHarness = loadMainFacet(
    loader,
    artifact("2123456789abcdef0123456789abcdef01234567", "main.js", [
      {
        name: "main.js",
        source: facetModule('"first harness"'),
      },
    ]),
  );
  const secondHarness = loadMainFacet(
    loader,
    artifact("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "main.js", [
      {
        name: "main.js",
        source: facetModule('"second harness"'),
      },
    ]),
  );

  expect(firstHarness.isOk()).toBe(true);
  expect(secondHarness.isOk()).toBe(true);
  expect(loaderNames).toEqual([
    "2123456789abcdef0123456789abcdef01234567",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  ]);
  if (firstHarness.isErr() || secondHarness.isErr()) {
    return;
  }

  expect(await responseText(firstHarness.value.worker)).toBe("first harness");
  expect(await responseText(secondHarness.value.worker)).toBe("second harness");
});

test("reuses the cached Worker Loader entry when the same harness commit is loaded again", async () => {
  const harnessCommit = "5123456789abcdef0123456789abcdef01234567";
  const firstHarness = loadMainFacet(
    env.LOADER,
    artifact(harnessCommit, "main.js", [
      { name: "main.js", source: facetModule('"code the commit was labeled with"') },
    ]),
  );
  const rebuiltHarness = loadMainFacet(
    env.LOADER,
    artifact(harnessCommit, "main.js", [
      { name: "main.js", source: facetModule('"code the commit was not labeled with"') },
    ]),
  );

  expect(firstHarness.isOk()).toBe(true);
  expect(rebuiltHarness.isOk()).toBe(true);
  if (firstHarness.isErr() || rebuiltHarness.isErr()) {
    return;
  }

  expect(await responseText(firstHarness.value.worker)).toBe("code the commit was labeled with");
  expect(
    await responseText(rebuiltHarness.value.worker),
    "a labeled commit is immutable, so its Loader entry must not change under it",
  ).toBe("code the commit was labeled with");
});

test("returns the raw invalid harness commit in artifact input diagnostics", () => {
  const loaderNames: string[] = [];

  const loadedHarness = loadMainFacet(
    loaderWithRecordedNames(loaderNames),
    artifact("main", "main.js", [{ name: "main.js", source: facetModule('"ignored"') }]),
  );

  expect(loadedHarness.isErr()).toBe(true);
  if (loadedHarness.isOk()) {
    return;
  }

  expect(loadedHarness.error).toEqual({ code: "invalid-harness-commit", harnessCommit: "main" });
  expect(loaderNames).toEqual([]);
});

test("rejects an artifact with no entry module before calling the Worker Loader", () => {
  const loaderNames: string[] = [];
  const loadedHarness = loadMainFacet(
    loaderWithRecordedNames(loaderNames),
    artifact("4123456789abcdef0123456789abcdef01234567", "main.js", [
      {
        name: "other.js",
        source: 'export default { fetch() { return new Response("other"); } };',
      },
    ]),
  );

  expect(loadedHarness.isErr()).toBe(true);
  if (loadedHarness.isOk()) {
    return;
  }

  expect(loadedHarness.error).toEqual({
    code: "entry-module-not-found",
    entryModule: "main.js",
  });
  expect(loaderNames).toEqual([]);
});
