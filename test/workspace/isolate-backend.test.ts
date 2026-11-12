import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import { WorkspaceHost } from "../../src/workspace/host.js";
import { seedWorkspaceRoot } from "./host-fixtures.js";

async function linesOf(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const text = await new Response(stream).text();

  return text.split("\n").filter((line) => line !== "");
}

function runIn(name: string, backend?: "isolate", command = "grep two notes.txt") {
  return runInDurableObject(env.WORKSPACE_HOST.getByName(name), async (host, state) => {
    await seedWorkspaceRoot(state);
    const project = await host.project({ remainingMs: 60_000 });
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

  expect(lines).toEqual([
    JSON.stringify({ kind: "stdout", seq: 0, data: "two\n" }),
    JSON.stringify({ kind: "terminal", seq: 1, outcome: "exited", exitCode: 0 }),
  ]);
});

test("git asked to run in the isolate is refused with an error that names the container", async () => {
  const lines = await runIn("isolate-git-refused", "isolate", "git status");

  expect(lines).toEqual([
    JSON.stringify({
      kind: "stderr",
      seq: 0,
      data: 'git runs only in the container. Leave out backend, or pass backend: "container".\n',
    }),
    JSON.stringify({ kind: "terminal", seq: 1, outcome: "exited", exitCode: 1 }),
  ]);
});

test("a command that writes to /dev/null runs in the isolate and discards the output", async () => {
  const lines = await runIn("isolate-dev-null", undefined, "echo hi > /dev/null && echo done");

  expect(lines).toEqual([
    JSON.stringify({ kind: "stdout", seq: 0, data: "done\n" }),
    JSON.stringify({ kind: "terminal", seq: 1, outcome: "exited", exitCode: 0 }),
  ]);
});

test("appending to a file that does not exist creates it", async () => {
  const lines = await runIn(
    "isolate-append-new",
    "isolate",
    "echo hi >> fresh.txt && cat fresh.txt",
  );

  expect(lines).toEqual([
    JSON.stringify({ kind: "stdout", seq: 0, data: "hi\n" }),
    JSON.stringify({ kind: "terminal", seq: 1, outcome: "exited", exitCode: 0 }),
  ]);
});

test("isolate commands open no new request back into their host", async () => {
  const opened = await runInDurableObject(
    env.WORKSPACE_HOST.getByName("isolate-no-loopback"),
    async (host, state) => {
      await seedWorkspaceRoot(state);
      const opens = vi.spyOn(WorkspaceHost.prototype, "openIsolateWorkspace");
      const project = await host.project({ remainingMs: 60_000 });

      for (const command of ["true", "echo hi >> a.txt", "git status"]) {
        const started = await project.startExec({ command, timeoutMs: 10_000, backend: "isolate" });

        if (!started.ok) throw new Error(started.error.code);
        await new Response(started.value.events).text();
      }

      const calls = opens.mock.calls.length;
      opens.mockRestore();

      return calls;
    },
  );

  expect(opened).toBe(0);
});

test("a holder of the WORKSPACE_HOST binding cannot get the workspace without the isolate's token", async () => {
  const outcome = await runInDurableObject(env.WORKSPACE_HOST.getByName("isolate-gate"), (host) =>
    host.openIsolateWorkspace("guess").then(() => "opened", String),
  );

  expect(outcome).toContain("not the isolate shell");
});
