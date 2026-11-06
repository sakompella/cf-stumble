import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { seedWorkspaceRoot } from "./host-fixtures.js";

async function linesOf(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const text = await new Response(stream).text();

  return text.split("\n").filter((line) => line !== "");
}

function runIn(name: string, backend?: "isolate" | "container", command = "grep two notes.txt") {
  return runInDurableObject(env.WORKSPACE_HOST.getByName(name), async (host, state) => {
    await seedWorkspaceRoot(state);
    const project = host.project({ remainingMs: 60_000 });
    await project.writeFile("/notes.txt", new TextEncoder().encode("one\ntwo\n"), "overwrite");

    const started = await project.startExec({
      command,
      timeoutMs: 10_000,
      backend,
    });

    if (!started.ok) throw new Error(started.error.code);

    return linesOf(started.value.events);
  });
}

test("a command asked to run in the isolate runs there against the workspace files", async () => {
  const lines = await runIn("isolate-routing-isolate", "isolate");

  expect(lines).toEqual([
    JSON.stringify({ kind: "stdout", seq: 0, data: "two\n" }),
    JSON.stringify({ kind: "terminal", seq: 1, outcome: "exited", exitCode: 0 }),
  ]);
});

test("a command with no backend and only isolate programs runs in the isolate", async () => {
  const lines = await runIn("isolate-routing-auto");

  expect(lines.at(-1)).toContain('"outcome":"exited"');
});

test.each([
  ["isolate-routing-container", "container" as const, "grep two notes.txt"],
  ["isolate-routing-fallback", "isolate" as const, "node -v"],
  ["isolate-routing-auto-node", undefined, "node -v"],
  ["isolate-routing-git", "isolate" as const, "git status"],
])("%s goes to the container", async (name, backend, command) => {
  const lines = await runIn(name, backend, command);

  expect(lines.at(-1)).toContain('"outcome":"failed"');
});

test("a holder of the WORKSPACE_HOST binding cannot get the workspace without the isolate's token", async () => {
  const outcome = await runInDurableObject(env.WORKSPACE_HOST.getByName("isolate-gate"), (host) =>
    host.openIsolateWorkspace("guess").then(() => "opened", String),
  );

  expect(outcome).toContain("not the isolate shell");
});
