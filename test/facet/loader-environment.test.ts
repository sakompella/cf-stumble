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
  expectTypeOf<keyof ConstructorParameters<typeof MainFacet>[1]>().toEqualTypeOf<
    keyof MainFacetCapabilities
  >();
  expectTypeOf<ConversationHost["workspace"]>().returns.toEqualTypeOf<
    Promise<ProjectRpcTargetContract & Disposable>
  >();
});
