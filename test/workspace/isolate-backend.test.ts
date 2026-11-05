import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Schema from "effect/Schema";
import { expect, test } from "vitest";
import { WorkspaceHost } from "../../src/workspace/index.js";
import { seedWorkspaceRoot } from "./host-fixtures.js";

const decodeEvent = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.optionalKey(Schema.String),
      exitCode: Schema.optionalKey(Schema.Number),
    }),
  ),
);

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
])("%s goes to the container", async (name, backend, command) => {
  const lines = await runIn(name, backend, command);

  expect(lines.at(-1)).toContain('"outcome":"failed"');
});

const IDENTITY =
  "GIT_AUTHOR_NAME=a GIT_AUTHOR_EMAIL=a@example.com GIT_COMMITTER_NAME=a GIT_COMMITTER_EMAIL=a@example.com";

test("git init, add, commit, status, log and diff run in the isolate", async () => {
  const lines = await runIn(
    "isolate-git",
    "isolate",
    [
      "git init",
      "git add notes.txt",
      `${IDENTITY} git commit -m first`,
      "echo three >> notes.txt",
      "git status --short",
      "git log --oneline",
      "git diff",
    ].join(" && "),
  );

  const output = lines.map((line) => decodeEvent(line));

  expect(output.at(-1)?.exitCode).toBe(0);
  expect(output.map((event) => event.data ?? "").join("")).toMatch(
    /M notes\.txt[\s\S]*first[\s\S]*\+three/u,
  );
});

test("a holder of the WORKSPACE_HOST binding cannot get the workspace without the isolate's token", async () => {
  const outcome = await runInDurableObject(env.WORKSPACE_HOST.getByName("isolate-gate"), (host) =>
    host.openIsolateWorkspace("guess").then(() => "opened", String),
  );

  expect(outcome).toContain("not the isolate shell");
  expect("__getWorkspaceStub" in WorkspaceHost.prototype).toBe(false);
});
