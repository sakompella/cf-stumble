import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { loadMainFacet, type MainHarnessArtifact } from "../../src/facet/index.js";
import type { MainHarnessArtifactInput } from "../../src/facet/artifact.js";
import { parsedArtifact } from "./fixture.js";

function artifact(
  harnessCommit: string,
  entryModule: string,
  modules: MainHarnessArtifactInput["modules"],
): MainHarnessArtifact {
  return parsedArtifact({ harnessCommit, entryModule, modules });
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

  expect(await responseText(loadedHarness.worker)).toBe("from an imported module");
});

test("a SHA-1 harness commit and a SHA-256 harness commit each serve their own code", async () => {
  const firstHarness = loadMainFacet(
    env.LOADER,
    artifact("2123456789abcdef0123456789abcdef01234567", "main.js", [
      {
        name: "main.js",
        source: facetModule('"first harness"'),
      },
    ]),
  );

  const secondHarness = loadMainFacet(
    env.LOADER,
    artifact("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "main.js", [
      {
        name: "main.js",
        source: facetModule('"second harness"'),
      },
    ]),
  );

  expect(await responseText(firstHarness.worker)).toBe("first harness");
  expect(await responseText(secondHarness.worker)).toBe("second harness");
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

  expect(await responseText(firstHarness.worker)).toBe("code the commit was labeled with");
  expect(
    await responseText(rebuiltHarness.worker),
    "a labeled commit is immutable, so its Loader entry must not change under it",
  ).toBe("code the commit was labeled with");
});

test("a loaded facet can yield to the event loop through a global MessageChannel, as the pi-durable writer does", async () => {
  const loadedHarness = loadMainFacet(
    env.LOADER,
    artifact("6123456789abcdef0123456789abcdef01234567", "main.js", [
      {
        name: "main.js",
        source: `
import { DurableObject } from "cloudflare:workers";
const hop = () =>
  new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve("hopped");
    };
    channel.port2.postMessage(undefined);
  });
export class MainFacet extends DurableObject {}
export default {
  fetch: async () => new Response(await hop()),
};
`,
      },
    ]),
  );

  expect(await responseText(loadedHarness.worker)).toBe("hopped");
});
