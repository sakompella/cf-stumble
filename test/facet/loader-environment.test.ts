/// <reference types="@cloudflare/vitest-plugin/types" />

import { env, exports as workerExports } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, describe, expect, expectTypeOf, test } from "vitest";
import { ProjectRpcTarget } from "../../src/workspace/project/index.js";
import {
  FakeExecBackend,
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
} from "../workspace/project/fakes.js";
import type { MainFacetCapabilities } from "../../src/facet/index.js";
import type { ConversationHost } from "../../src/facet/index.js";
import type { MainFacet } from "../../src/facet/generation-1/main-facet.js";
import type { ProjectRpcTargetContract } from "../../src/workspace/project/protocol.js";

/**
 * A project capability must reach a run through the attached host and never through loader environment.
 * `test/facet/loader.test.ts` shows why: the Worker Loader caches its entry under the harness
 * commit, so a capability installed there outlives the request that installed it and serves every
 * later request for that generation. For a capability scoped to one project that means the first
 * project to warm the cache would answer for all of them.
 *
 * The checks below hold that line from two directions: the platform refuses the serialization, and
 * the loader-environment type has no slot to put it in while the host hands one out per
 * conversation. That a mounted facet's environment holds only `MODEL` is already checked by
 * `test/facet/mounted-facet.test.ts`, against a facet the Supervisor really mounted.
 */

const modelRoute = workerExports.ModelRoute({});

function projectTarget(): ProjectRpcTarget {
  return new ProjectRpcTarget(
    new FakeProjectFilesystemProvider(),
    new FakeProjectTransactions(),
    new FakeExecBackend(),
  );
}

function reportEnvKeys(): string {
  return `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  fetch() {
    return Response.json(Object.keys(this.env).sort());
  }
}
`;
}

afterEach(async () => {
  await reset();
});

describe("platform assumptions", () => {
  test("the Worker Loader refuses to carry a project capability in a facet's environment", () => {
    const target = projectTarget();

    expect(
      () =>
        env.LOADER.load({
          compatibilityDate: "2025-01-01",
          mainModule: "main.js",
          modules: { "main.js": { js: reportEnvKeys() } },
          env: { MODEL: modelRoute, PROJECT: target },
          globalOutbound: null,
        }),
      "an RpcTarget is only serializable for an RPC call, so this cannot silently succeed",
    ).toThrow("can only be serialized for RPC");
  });
});

test("the loader environment type has no project slot and the host hands one out per conversation", () => {
  expectTypeOf<MainFacetCapabilities>().toEqualTypeOf<{
    readonly MODEL: MainFacetCapabilities["MODEL"];
  }>();
  expectTypeOf<keyof MainFacetCapabilities>().toEqualTypeOf<"MODEL">();
  // The generation declares its own environment separately from what the host installs. Holding
  // the two to the same keys is what stops a project-scoped slot being declared on one side only.
  expectTypeOf<keyof ConstructorParameters<typeof MainFacet>[1]>().toEqualTypeOf<
    keyof MainFacetCapabilities
  >();
  expectTypeOf<ConversationHost["workspace"]>().returns.toEqualTypeOf<
    Promise<ProjectRpcTargetContract>
  >();
});
