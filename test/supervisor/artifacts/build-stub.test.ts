import { expect, test } from "vitest";
import { parseHarnessCommit, type HarnessCommit } from "../../../src/harness-commit.js";
import { WorkspaceHostModuleMapBuilder } from "../../../src/supervisor/artifacts/index.js";
import { HARNESS_BUILD_STEP_NAMES, type HarnessBuildRequest } from "../../../src/harness-build.js";
import type { WorkspaceResult } from "../../../src/workspace/index.js";
import { fixtureMainHarnessArtifact } from "../../../src/facet/fixture.js";

function harnessCommit(value: string): HarnessCommit {
  const parsed = parseHarnessCommit(value);
  if (parsed === undefined) {
    throw new Error("the test commit must be a valid harness commit");
  }

  return parsed;
}

const commit = harnessCommit("30000000000000000000000000000000000000ab");

function moduleMapFile(): string {
  return JSON.stringify({
    entryModule: fixtureMainHarnessArtifact.entryModule,
    modules: fixtureMainHarnessArtifact.modules,
  });
}

/** One Workspace Host stub. It records the one request it is asked for and nothing else. */
class OneCallHost {
  readonly requests: HarnessBuildRequest[] = [];

  build(request: HarnessBuildRequest): Promise<WorkspaceResult> {
    this.requests.push(request);
    return Promise.resolve({
      ok: true,
      result: {
        kind: "command",
        stdout: request.kind === "build-output" ? moduleMapFile() : "",
        stderr: "",
        exitCode: 0,
      },
    });
  }
}

test("takes a fresh workspace stub for every call in one build", async () => {
  const hosts: OneCallHost[] = [];
  const builder = new WorkspaceHostModuleMapBuilder(
    {
      getByName: () => {
        const host = new OneCallHost();
        hosts.push(host);
        return host;
      },
    },
    "tenant-workspace",
  );

  const built = await builder.build(commit);

  expect(built.isOk(), "the build reads its own output").toBe(true);
  expect(
    hosts.length,
    "a build that held one stub died with the Workspace Host it was taken from, minutes earlier",
  ).toBe(HARNESS_BUILD_STEP_NAMES.length + 1);
  expect(hosts.every((host) => host.requests.length === 1)).toBe(true);
});
