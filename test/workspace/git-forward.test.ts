import { Workspace } from "@cloudflare/computer";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Schema from "effect/Schema";
import { expect, test } from "vitest";
import { forwardGit } from "../../src/workspace/git-forward.js";
import { gitForwardToken } from "../../src/workspace/route-fetch.js";
import { computerStorage } from "../../src/workspace/workspace-platform.js";
import { workspaceGit } from "../../src/workspace/project/index.js";
import { seedWorkspaceRoot } from "./host-fixtures.js";

const Forwarded = Schema.Struct({
  stdout: Schema.String,
  exitCode: Schema.Number,
  gitDir: Schema.NullOr(Schema.String),
  state: Schema.Record(Schema.String, Schema.String),
});

const SETUP = [
  "git init",
  "git config user.name Test",
  "git config user.email test@example.com",
  "echo one > a.txt",
  "git add -A",
  "git commit -q -m first",
].join(" && ");

function request(token: string | null, method: string, body: string): Request {
  return new Request("http://computer.internal/api", {
    method,
    body: method === "POST" ? body : null,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

test.each([
  ["no token", null, "POST", 401],
  ["a wrong token", "not-the-token", "POST", 401],
])("the git route refuses %s", async (_name, token, method, status) => {
  const response = await runInDurableObject(
    env.WORKSPACE_HOST.getByName("git-route-refuse"),
    (host, state) => {
      const presented = token === "token" ? gitForwardToken(state.storage.kv) : token;

      return host.fetch(request(presented, method, "{}"));
    },
  );

  expect(response.status).toBe(status);
});

const INNER_SETUP = [
  "mkdir inner",
  "cd inner",
  "git init",
  "git config user.name T",
  "git config user.email t@example.com",
  "echo i > i.txt",
  "git add i.txt",
  "git commit -q -m inner-first",
].join(" && ");

test("the git route rejects a body that is not {argv, cwd}", async () => {
  const response = await runInDurableObject(
    env.WORKSPACE_HOST.getByName("git-route-body"),
    (host, state) =>
      host.fetch(request(gitForwardToken(state.storage.kv), "POST", '{"argv":"status"}')),
  );

  expect(response.status).toBe(400);
});

test("the token is stable across reads and differs between Hosts", async () => {
  const first = await runInDurableObject(env.WORKSPACE_HOST.getByName("token-a"), (_host, state) =>
    Promise.resolve([gitForwardToken(state.storage.kv), gitForwardToken(state.storage.kv)]),
  );

  const second = await runInDurableObject(env.WORKSPACE_HOST.getByName("token-b"), (_host, state) =>
    Promise.resolve(gitForwardToken(state.storage.kv)),
  );

  expect(first[0]).toBe(first[1]);
  expect(second).not.toBe(first[0]);
});

test("a git cli failure becomes a generic 500 without leaking the cause", async () => {
  const outcome = await runInDurableObject(
    env.WORKSPACE_HOST.getByName("git-forward-internal-error"),
    async (_host, state) => {
      await seedWorkspaceRoot(state);

      const workspace = new Workspace({
        storage: computerStorage(state.storage),
        sessionId: state.id.toString(),
        backends: [],
        git: (options) => ({
          ...workspaceGit(options),
          cli: () => Promise.reject(new Error("sentinel internal detail")),
        }),
      });

      const response = await forwardGit(
        workspace,
        "container-shell",
        JSON.stringify({ argv: ["status", "-s"], cwd: "/workspace" }),
      );

      return { status: response.status, body: await response.text() };
    },
  );

  expect(outcome.status).toBe(500);
  expect(outcome.body).toBe("git forward failed");
});

test("a forwarded git -C describes the repository the command changed", async () => {
  const outcome = await runInDurableObject(
    env.WORKSPACE_HOST.getByName("git-forward-nested"),
    async (host, state) => {
      await seedWorkspaceRoot(state);

      const run = async (command: string) => {
        const started = await host
          .project({ remainingMs: 60_000 })
          .startExec({ command, timeoutMs: 20_000, backend: "isolate" });

        if (!started.ok) throw new Error(started.error.code);

        return new Response(started.value.events).text();
      };

      await run(SETUP);
      await run(INNER_SETUP);
      await run("cd inner && echo more >> i.txt");

      const workspace = new Workspace({
        storage: computerStorage(state.storage),
        sessionId: state.id.toString(),
        backends: [],
        git: workspaceGit,
      });

      const response = await forwardGit(
        workspace,
        "container-shell",
        JSON.stringify({
          argv: ["-C", "/workspace/inner", "commit", "-q", "-am", "inner change"],
          cwd: "/workspace",
        }),
      );

      return {
        response: Schema.decodeUnknownSync(Forwarded)(await response.json()),
        log: await run("git -C inner log -1 --format=%s"),
      };
    },
  );

  expect(outcome.response.exitCode).toBe(0);
  expect(outcome.response.gitDir).toBe("/workspace/inner/.git");
  expect(outcome.response.state["HEAD"]).not.toBe("");
  expect(outcome.log).toContain("inner change");
});

test("a forwarded commit is visible to an isolate read right away", async () => {
  const outcome = await runInDurableObject(
    env.WORKSPACE_HOST.getByName("git-forward-commit"),
    async (host, state) => {
      await seedWorkspaceRoot(state);

      const run = async (command: string) => {
        const started = await host
          .project({ remainingMs: 60_000 })
          .startExec({ command, timeoutMs: 20_000, backend: "isolate" });

        if (!started.ok) throw new Error(started.error.code);

        return new Response(started.value.events).text();
      };

      await run(SETUP);
      await run("echo two >> a.txt");

      const workspace = new Workspace({
        storage: computerStorage(state.storage),
        sessionId: state.id.toString(),
        backends: [],
        git: workspaceGit,
      });

      const body = JSON.stringify({
        argv: ["commit", "-a", "-m", "from the container"],
        cwd: "/workspace",
      });

      const response = await forwardGit(workspace, "container-shell", body);
      const log = await run("git log -1 --format=%s");

      return { response: Schema.decodeUnknownSync(Forwarded)(await response.json()), log };
    },
  );

  expect(outcome.log).toContain("from the container");
  expect(outcome.response.exitCode).toBe(0);
  expect(outcome.response.gitDir).toBe("/workspace/.git");
  expect(outcome.response.state["HEAD"]).toMatch(/^[0-9a-f]{64}$/u);
  expect(outcome.response.state["index"]).toMatch(/^[0-9a-f]{64}$/u);
  expect(outcome.response.stdout).toContain("from the container");
});
