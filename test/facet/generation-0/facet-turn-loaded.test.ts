/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import {
  FakeExecBackend,
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
} from "../../workspace/project/fakes.js";
import { calls, encode, readFrames, says } from "./facet-turn-helpers.js";
import type { FacetTurnRequest } from "../../../src/facet/generation-0/facet-turn.js";
import type { ModelRouteResponse } from "../../../src/model-route.js";
import type LoadedFacetTurnEntry from "./loaded-facet-turn-entry.js";

/**
 * Proves the whole capability path against the real runtime rather than a stand-in: a live
 * `ProjectRpcTarget` constructed here, handed as an RPC method argument into a genuinely separate
 * Worker Loader isolate, driving a real turn there whose stock tools reach back across the hop and
 * change files this test can then read directly.
 *
 * The isolate's own environment holds one plain string of scripted model answers and nothing else,
 * which is the split this phase exists to establish: generation-invariant configuration rides
 * loader environment, and a capability belonging to one project never does.
 *
 * `tools/build-loaded-execution-env-fixture.mts` bundles `loaded-facet-turn-entry.ts` into
 * `build/loaded-facet-turn-fixture.json`, gitignored alongside `build/module-map.json`, and
 * `pnpm verify` runs that build before the tests.
 */
declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { readonly eager: true; readonly query: "?raw"; readonly import: "default" },
    ) => Record<string, string>;
  }
}

const builtFile = Object.values(
  import.meta.glob("../../../build/loaded-facet-turn-fixture.json", {
    eager: true,
    query: "?raw",
    import: "default",
  }),
).at(0);

interface BuiltFixtureFile {
  readonly entryModule: string;
  readonly modules: readonly { readonly name: string; readonly source: string }[];
}

function builtFixture(): Promise<BuiltFixtureFile> {
  expect(builtFile, "run pnpm build:loaded-execution-env-fixture before the tests").toBeDefined();
  return new Response(builtFile ?? "").json<BuiltFixtureFile>();
}

function moduleEntry(module: BuiltFixtureFile["modules"][number]): [string, WorkerLoaderModule] {
  return [module.name, { js: module.source }];
}

async function loadFacet(
  answers: readonly ModelRouteResponse[],
): Promise<Fetcher<LoadedFacetTurnEntry>> {
  const fixture = await builtFixture();
  const worker = env.LOADER.load({
    compatibilityDate: "2025-01-01",
    mainModule: fixture.entryModule,
    modules: Object.fromEntries(fixture.modules.map(moduleEntry)),
    env: { MODEL_SCRIPT: JSON.stringify(answers) },
    globalOutbound: null,
  });
  return worker.getEntrypoint<LoadedFacetTurnEntry>();
}

/**
 * A real `ProjectRpcTarget` with the disposer Workers RPC honours. The runtime runs it once every
 * stub pointing at this instance has been disposed, so it fires only if the turn released the
 * duplicate it leased.
 */
class DisposableProjectTarget extends ProjectRpcTarget {
  disposals = 0;

  [Symbol.dispose](): void {
    this.disposals += 1;
  }
}

function makeWorkspace() {
  const provider = new FakeProjectFilesystemProvider();
  const execBackend = new FakeExecBackend();
  const target = new DisposableProjectTarget(provider, new FakeProjectTransactions(), execBackend);
  return { provider, execBackend, target };
}

const OPENING: FacetTurnRequest = { prompt: "Change the file.", messages: [] };

afterEach(async () => {
  await reset();
});

test("a loaded isolate runs a turn against a capability passed as an RPC argument", async () => {
  const workspace = makeWorkspace();
  workspace.provider.addFile("/workspace/notes.txt", encode("hello world"));
  const facet = await loadFacet([
    calls("read", { path: "notes.txt" }),
    says("The file says hello world."),
  ]);

  const frames = await readFrames(await facet.startTurn(workspace.target, OPENING, "/workspace"));

  expect(frames.map((frame) => frame.kind)).toEqual([
    "tool-start",
    "tool-result",
    "text",
    "completed",
  ]);
  expect(
    frames[1],
    "the read only succeeds if it reached the file this test created in its own isolate",
  ).toMatchObject({
    kind: "tool-result",
    toolName: "read",
    isError: false,
    content: "hello world",
  });
  expect(frames[2]).toEqual({ kind: "text", text: "The file says hello world." });
});

test("the turn's tool writes reach the originating workspace across the RPC hop", async () => {
  const workspace = makeWorkspace();
  const facet = await loadFacet([
    calls("write", { path: "made-by-the-turn.txt", content: "across the hop" }),
    says("Wrote it."),
  ]);

  const frames = await readFrames(await facet.startTurn(workspace.target, OPENING, "/workspace"));

  expect(frames.at(-1)).toMatchObject({ kind: "completed" });
  expect(
    workspace.provider.readFileSync("/workspace/made-by-the-turn.txt"),
    "the loaded isolate had no filesystem of its own; these bytes can only have arrived over RPC",
  ).toEqual(encode("across the hop"));
});

test("the turn runs a command through the capability and reads its byte-framed output", async () => {
  const workspace = makeWorkspace();
  const facet = await loadFacet([calls("bash", { command: "echo hi" }), says("It printed hi.")]);

  const framesPromise = readFrames(await facet.startTurn(workspace.target, OPENING, "/workspace"));
  await vi.waitFor(() => {
    expect(workspace.execBackend.requests.length).toBeGreaterThan(0);
  });

  expect(workspace.execBackend.requests[0]).toMatchObject({
    command: "echo hi",
    cwd: "/workspace",
  });
  const handle = workspace.execBackend.handles[0]!;
  handle.push({ name: "stdout", data: encode("hi\n") });
  // oxlint-disable-next-line unicorn/prefer-single-call -- `push` queues one exec event per call, not array elements to merge.
  handle.push({ name: "exit", exitCode: 0 });

  const frames = await framesPromise;
  expect(frames[1]).toMatchObject({ kind: "tool-result", toolName: "bash", isError: false });
  expect(frames.at(-1)).toMatchObject({ kind: "completed" });
});

test("the loaded isolate's environment holds no capability, only the plain model script", async () => {
  const facet = await loadFacet([says("nothing to do")]);

  expect(await facet.environmentKeys()).toEqual(["MODEL_SCRIPT"]);
});

/**
 * An end-state check, not a check of which line released the lease. workerd also reclaims a call's
 * remaining stubs when its execution context ends, so this passes even with the turn's own release
 * deleted. `facet-turn-disposal.test.ts` is what guards each of the three release paths; this only
 * shows nothing survives the turn to pin the isolate open.
 */
test("no stub for the workspace outlives a finished turn", async () => {
  const workspace = makeWorkspace();
  const facet = await loadFacet([
    calls("write", { path: "released.txt", content: "done" }),
    says("Wrote it."),
  ]);

  const frames = await readFrames(await facet.startTurn(workspace.target, OPENING, "/workspace"));
  expect(frames.at(-1)).toMatchObject({ kind: "completed" });

  await vi.waitFor(() => {
    expect(
      workspace.target.disposals,
      "the runtime runs this disposer only once every stub for the target is disposed",
    ).toBe(1);
  });
});

test("a turn that kept the received stub instead of duplicating it would lose the workspace", async () => {
  const workspace = makeWorkspace();
  const facet = await loadFacet([]);

  const reported = await new Response(await facet.reachWithoutDuplicating(workspace.target)).text();

  expect(
    reported,
    "Workers RPC disposes a parameter stub when the call returns, which is why a turn leases a duplicate",
  ).toContain("used after being disposed");
});
