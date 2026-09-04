import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@cf-stumble/pi";
import { expect, test } from "vitest";
import { makeFacetExecutionEnv } from "./execution-env-target.js";

/**
 * Runs Pi's real stock tools — not a direct adapter call — against `createFacetExecutionEnv`,
 * backed by a real `ProjectRpcTarget` over an in-memory filesystem and a scripted exec backend.
 *
 * This does not cross an actual Worker Loader isolate boundary: `env` here is built directly in
 * this test's own isolate. `execution-env-loaded.test.ts` covers that boundary — a live
 * `ProjectRpcTarget` passed as an RPC method argument into a genuinely separate loaded Worker,
 * with the same stock tools run inside that other isolate.
 */

function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function fullOutputPathOf(details: { fullOutputPath?: string } | undefined): string {
  if (details?.fullOutputPath === undefined)
    throw new Error("expected a fullOutputPath in bash tool details");
  return details.fullOutputPath;
}

test("createWriteTool, createReadTool, and createEditTool round-trip a file through the adapter", async () => {
  const { env } = makeFacetExecutionEnv();
  const writeTool = createWriteTool();
  const readTool = createReadTool();
  const editTool = createEditTool();

  await writeTool.execute(
    "call-1",
    { path: "notes.txt", content: "hello world" },
    undefined,
    undefined,
    { env },
  );
  const read = await readTool.execute("call-2", { path: "notes.txt" }, undefined, undefined, {
    env,
  });
  expect(read.content).toEqual([{ type: "text", text: "hello world" }]);

  await editTool.execute(
    "call-3",
    { path: "notes.txt", edits: [{ oldText: "world", newText: "there" }] },
    undefined,
    undefined,
    { env },
  );
  const reread = await readTool.execute("call-4", { path: "notes.txt" }, undefined, undefined, {
    env,
  });
  expect(reread.content).toEqual([{ type: "text", text: "hello there" }]);
});

test("createBashTool output over 50KiB is captured whole to a create-exclusive temp file, appended in order", async () => {
  const { execBackend, env } = makeFacetExecutionEnv();
  const tool = createBashTool();
  const chunk1 = "start\n".repeat(5);
  // A single chunk large enough to push accumulated bytes past the 50KiB truncation threshold.
  const filler = `${"x".repeat(60 * 1024)}\n`;
  const chunk3 = "tail-chunk\n";
  const fullOutput = chunk1 + filler + chunk3;

  const execPromise = tool.execute("call-1", { command: "produce-bytes" }, undefined, undefined, {
    env,
  });
  await tick();
  const handle = execBackend.handles[0]!;
  const events = [
    { name: "stdout" as const, data: new TextEncoder().encode(chunk1) },
    { name: "stdout" as const, data: new TextEncoder().encode(filler) },
    { name: "stdout" as const, data: new TextEncoder().encode(chunk3) },
    { name: "exit" as const, exitCode: 0 },
  ];
  for (const event of events) handle.push(event);

  const result = await execPromise;
  const fullOutputPath = fullOutputPathOf(result.details);
  expect(fullOutputPath.startsWith("/project/.cf-stumble/tmp/")).toBe(true);
  await expect(env.readTextFile(fullOutputPath)).resolves.toEqual({ ok: true, value: fullOutput });
});

test("createBashTool output over 2000 lines is captured whole to a temp file", async () => {
  const { execBackend, env } = makeFacetExecutionEnv();
  const tool = createBashTool();
  const manyLines = `${Array.from({ length: 2_500 }, (_, index) => `line-${index}`).join("\n")}\n`;

  const execPromise = tool.execute("call-1", { command: "produce-lines" }, undefined, undefined, {
    env,
  });
  await tick();
  const handle = execBackend.handles[0]!;
  const events = [
    { name: "stdout" as const, data: new TextEncoder().encode(manyLines) },
    { name: "exit" as const, exitCode: 0 },
  ];
  for (const event of events) handle.push(event);

  const result = await execPromise;
  const fullOutputPath = fullOutputPathOf(result.details);
  await expect(env.readTextFile(fullOutputPath)).resolves.toEqual({ ok: true, value: manyLines });
});
