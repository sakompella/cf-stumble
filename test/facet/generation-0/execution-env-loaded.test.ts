/// <reference types="@cloudflare/vitest-plugin/types" />

// The single integration test below drives four stock tools plus two host-side synchronization
// checkpoints against a loaded isolate; splitting it would scatter one continuous proof.
// oxlint-disable eslint/max-lines-per-function

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import {
  FakeExecBackend,
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
} from "../../workspace/project/fakes.js";
import type { PlainToolEvidence } from "./loaded-execution-env-entry.js";
import type LoadedExecutionEnvEntry from "./loaded-execution-env-entry.js";

/**
 * Proves what `execution-env-tools.test.ts` could not: that a live `ProjectRpcTarget`, passed as
 * an RPC method argument into a genuinely separate Worker Loader isolate, still works — decoding
 * `startExec`'s `ReadableStream<Uint8Array>` wire frames and running Pi's real stock tools —
 * exactly as it does when called in-process. No fake stands in for `ProjectRpcTargetContract`
 * here; every filesystem and exec call the loaded isolate makes lands on the real
 * `ProjectRpcTarget` this test constructs, backed by the same deterministic fakes the rest of
 * this suite uses.
 *
 * `tools/build-loaded-execution-env-fixture.mts` bundles `loaded-execution-env-entry.ts` into
 * `build/loaded-execution-env-fixture.json`, gitignored alongside `build/module-map.json`.
 * `pnpm build:loaded-execution-env-fixture` writes it, and `pnpm verify` runs that build before
 * the tests, matching `module-map.test.ts`'s pattern for the main facet's own built artifact.
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
  import.meta.glob("../../../build/loaded-execution-env-fixture.json", {
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

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Polls a host-side condition driven by RPC calls the loaded isolate makes asynchronously. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for the loaded isolate's exec request");
    }
    // oxlint-disable-next-line no-await-in-loop -- Each poll must observe the previous one's result before the next.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

function moduleEntry(module: BuiltFixtureFile["modules"][number]): [string, WorkerLoaderModule] {
  return [module.name, { js: module.source }];
}

async function loadEntrypoint(): Promise<Fetcher<LoadedExecutionEnvEntry>> {
  const fixture = await builtFixture();
  const worker = env.LOADER.load({
    compatibilityDate: "2025-01-01",
    mainModule: fixture.entryModule,
    modules: Object.fromEntries(fixture.modules.map(moduleEntry)),
    env: {},
    globalOutbound: null,
  });
  return worker.getEntrypoint<LoadedExecutionEnvEntry>();
}

afterEach(async () => {
  await reset();
});

test("a loaded isolate runs Pi's stock tools against a ProjectRpcTarget passed as an RPC argument", async () => {
  const provider = new FakeProjectFilesystemProvider();
  const transactions = new FakeProjectTransactions();
  const execBackend = new FakeExecBackend();
  const projectTarget = new ProjectRpcTarget(provider, transactions, execBackend);

  const entrypoint = await loadEntrypoint();
  const evidencePromise: Promise<PlainToolEvidence> = entrypoint.exercise(projectTarget);

  // The entrypoint's raw wire-format probe runs first, before any of the four stock tools.
  await waitUntil(() => execBackend.requests.length > 0);
  expect(execBackend.requests[0]).toMatchObject({ command: "probe", cwd: "/project" });
  const probeHandle = execBackend.handles[0]!;
  probeHandle.push({ name: "stdout", data: encode("probe\n") });
  // oxlint-disable-next-line unicorn/prefer-single-call -- `push` here queues one exec event per call, not array elements to merge.
  probeHandle.push({ name: "exit", exitCode: 0 });

  // The entrypoint's checkpoint probe runs next, after write and read have resolved but before
  // the edit tool runs. It exists purely so the host can regain control and inspect the real,
  // host-side provider's bytes at a point in time when they can only reflect the write, not the
  // edit that has not run yet.
  await waitUntil(() => execBackend.requests.length >= 2);
  expect(execBackend.requests[1]).toMatchObject({ command: "checkpoint", cwd: "/project" });
  expect(provider.readFileSync("/project/notes.txt")).toEqual(encode("hello world"));
  const checkpointHandle = execBackend.handles[1]!;
  checkpointHandle.push({ name: "exit", exitCode: 0 });

  // createBashTool's own exec call arrives once the checkpoint and the edit have resolved.
  await waitUntil(() => execBackend.requests.length >= 3);
  expect(execBackend.requests[2]).toMatchObject({ command: "echo hi", cwd: "/project" });
  const bashHandle = execBackend.handles[2]!;
  bashHandle.push({ name: "stdout", data: encode("bash stdout\n") });
  // oxlint-disable-next-line unicorn/prefer-single-call -- `push` here queues one exec event per call, not array elements to merge.
  bashHandle.push({ name: "stderr", data: encode("bash stderr\n") });
  // oxlint-disable-next-line unicorn/prefer-single-call -- `push` here queues one exec event per call, not array elements to merge.
  bashHandle.push({ name: "exit", exitCode: 0 });

  const evidence = await evidencePromise;

  expect(evidence.write.text).toBe("Successfully wrote 11 bytes to notes.txt");

  // The read tool returned the original content, before the edit landed.
  expect(evidence.read.text).toBe("hello world");

  // The edit tool changed the file and returned the stock diff/patch details.
  expect(evidence.edit.text).toBe("Successfully replaced 1 block(s) in notes.txt.");
  expect(evidence.edit.diff).toContain("hello there");
  expect(evidence.edit.patch).toContain("hello there");
  expect(evidence.edit.firstChangedLine).toBe(1);
  expect(evidence.rereadAfterEdit.text).toBe("hello there");

  // The edit tool changed the file; the host-side provider holds the bytes it changed it to.
  expect(provider.readFileSync("/project/notes.txt")).toEqual(encode("hello there"));

  // The bash tool's command reached the same originating fake backend, with the facet's /project
  // cwd, and returned the stock combined stdout/stderr output in the order the events arrived.
  expect(evidence.bash.text).toBe("bash stdout\nbash stderr\n");

  // The wire itself is bytes: every raw frame this loaded isolate read directly, across the real
  // RPC hop, was a `Uint8Array`, not a structurally-cloned `ExecEvent` object.
  expect(evidence.rawExecFramesAreBytes).toBe(true);
});

test("a loaded isolate can pause and cancel a remote exec byte stream", async () => {
  const execBackend = new FakeExecBackend();
  const projectTarget = new ProjectRpcTarget(
    new FakeProjectFilesystemProvider(),
    new FakeProjectTransactions(),
    execBackend,
  );
  const entrypoint = await loadEntrypoint();

  const paused = entrypoint.pauseThenCancelExec(projectTarget);
  await waitUntil(() => execBackend.handles.length === 1);
  const handle = execBackend.handles[0]!;
  handle.push({ name: "stdout", data: encode("first") });
  // oxlint-disable-next-line unicorn/prefer-single-call
  handle.push({ name: "stdout", data: encode("second") });
  await Promise.resolve();
  await Promise.resolve();

  expect(handle.readCalls).toBeGreaterThan(0);
  await paused;
  expect(handle.killCalls).toBe(1);
});
