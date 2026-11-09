import { spawn, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, expect, test } from "vitest";
import { devShellTool } from "../dev-shell-tool.js";
import { git } from "./rooted-shell.js";

const WRAPPER = new URL("../../infra/workspace-image/git-readonly.sh", import.meta.url).pathname;

const FORWARDER = new URL("../../infra/workspace-image/git-forward.mts", import.meta.url).pathname;

type Finished = { code: number; stdout: string; stderr: string };

function run(file: string, args: readonly string[], options: SpawnOptions): Promise<Finished> {
  return new Promise((resolve) => {
    const child = spawn(file, args, options);
    const finished: Finished = { code: 1, stdout: "", stderr: "" };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      finished.stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      finished.stderr += chunk;
    });
    child.on("close", (code) => {
      finished.code = code ?? 1;
      resolve(finished);
    });
  });
}

const Body = Schema.Struct({ argv: Schema.Array(Schema.String), cwd: Schema.String });

const decodeBody = Schema.decodeUnknownSync(Schema.fromJsonString(Body));

const decodePort = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }));

type Reply = {
  stdout: string;
  stderr: string;
  exitCode: number;
  gitDir: string;
  state: Record<string, string>;
};

type Seen = { authorization: string | undefined; body: typeof Body.Type };

let root = "";

let repository = "";

let server: Server;

let seen: Seen[] = [];

let answer: (repository: string) => Reply = currentState;

let status = 200;

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function currentState(directory: string): Reply {
  const gitDir = join(directory, ".git");

  return {
    stdout: "[main abc1234] t\n",
    stderr: "",
    exitCode: 0,
    gitDir,
    state: { HEAD: digest(join(gitDir, "HEAD")), index: digest(join(gitDir, "index")) },
  };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "cf-stumble-git-forward-"));
  repository = join(root, "repository");
  git(root, "init", "-q", "-b", "main", "repository");
  git(repository, "commit", "-q", "--allow-empty", "-m", "first");
  seen = [];
  status = 200;
  answer = currentState;

  server = createServer((request, response) => {
    let text = "";

    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      text += chunk;
    });
    request.on("end", () => {
      seen.push({
        authorization: request.headers.authorization,
        body: decodeBody(text),
      });
      response.statusCode = status;
      response.end(status === 200 ? JSON.stringify(answer(repository)) : "refused");
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  rmSync(root, { recursive: true, force: true });
});

function address(): string {
  return `http://127.0.0.1:${String(decodePort(server.address()).port)}/git`;
}

function wrapped(args: readonly string[], environment: Record<string, string> = {}) {
  return run(devShellTool("dash"), [WRAPPER, "-C", repository, ...args], {
    cwd: root,
    env: {
      ...process.env,
      CF_STUMBLE_REAL_GIT: devShellTool("git"),
      CF_STUMBLE_GIT_TOKEN: "secret",
      CF_STUMBLE_GIT_FORWARD: FORWARDER,
      CF_STUMBLE_GIT_FORWARD_URL: address(),
      CF_STUMBLE_GIT_WAIT_MS: "400",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      ...environment,
    },
  });
}

function hook(name: string, script: string): void {
  const path = join(repository, ".git", "hooks", name);

  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
}

test("a write goes to the host with the token and the argv, and its output comes back", async () => {
  const ran = await wrapped(["commit", "-m", "t"]);

  expect(ran).toEqual({ code: 0, stdout: "[main abc1234] t\n", stderr: "" });
  expect(seen).toEqual([
    {
      authorization: "Bearer secret",
      body: { argv: ["-C", repository, "commit", "-m", "t"], cwd: root },
    },
  ]);
});

test("the host's exit code and stderr come back", async () => {
  answer = (directory) => ({ ...currentState(directory), stderr: "bad\n", exitCode: 3 });

  const ran = await wrapped(["commit", "-m", "t"]);

  expect(ran).toMatchObject({ code: 3, stderr: "bad\n" });
});

test("it fails with a clear error when the disk never shows the host's state", async () => {
  answer = (directory) => ({
    ...currentState(directory),
    state: { HEAD: "0".repeat(64) },
  });

  const ran = await wrapped(["commit", "-m", "t"]);

  expect(ran.code).toBe(1);
  expect(ran.stderr).toContain("still lacks the change (HEAD) after 400 ms");
});

test("it waits until the disk catches up", async () => {
  answer = (directory) => {
    setTimeout(() => {
      writeFileSync(join(directory, ".git", "late"), "x");
    }, 150);

    return {
      ...currentState(directory),
      state: { late: createHash("sha256").update("x").digest("hex") },
    };
  };

  const ran = await wrapped(["commit", "-m", "t"], { CF_STUMBLE_GIT_WAIT_MS: "3000" });

  expect(ran.code).toBe(0);
});

test("a refusal from the host is reported", async () => {
  status = 401;

  const ran = await wrapped(["commit", "-m", "t"]);

  expect(ran.code).toBe(1);
  expect(ran.stderr).toContain("the workspace host answered 401: refused");
});

test("a host that cannot be reached is reported", async () => {
  const ran = await wrapped(["commit", "-m", "t"], {
    CF_STUMBLE_GIT_FORWARD_URL: "http://127.0.0.1:1/git",
  });

  expect(ran.code).toBe(1);
  expect(ran.stderr).toContain("cannot reach the workspace host");
});

test("a failing pre-commit hook stops the commit before the host sees it", async () => {
  hook("pre-commit", "echo no >&2\nexit 1");

  const ran = await wrapped(["commit", "-m", "t"]);

  expect(ran.code).toBe(1);
  expect(ran.stderr).toContain("pre-commit hook failed");
  expect(seen).toEqual([]);
});

test("--no-verify skips the hooks", async () => {
  hook("pre-commit", "exit 1");

  const ran = await wrapped(["commit", "--no-verify", "-m", "t"]);

  expect(ran.code).toBe(0);
  expect(seen).toHaveLength(1);
});

test("a passing pre-commit hook runs in the work tree and the commit goes on", async () => {
  hook("pre-commit", "pwd > hook-ran");

  const ran = await wrapped(["commit", "-m", "t"]);

  expect(ran.code).toBe(0);
  expect(readFileSync(join(repository, "hook-ran"), "utf8").trim()).toBe(repository);
  expect(seen).toHaveLength(1);
});

test("core.hooksPath selects the hooks", async () => {
  const hooks = join(root, "shared-hooks");

  git(root, "init", "-q", "shared-hooks");
  writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(hooks, "pre-commit"), 0o755);
  git(repository, "config", "core.hooksPath", hooks);

  const ran = await wrapped(["commit", "-m", "t"]);

  expect(ran.code).toBe(1);
  expect(seen).toEqual([]);
});

test("a commit-msg hook can reject or rewrite the message", async () => {
  hook("commit-msg", 'echo "$(cat "$1") [checked]" > "$1"');

  const ran = await wrapped(["commit", "-m", "t"]);

  expect(ran.code).toBe(0);
  expect(seen[0]?.body.argv).toEqual(["-C", repository, "commit", "-m", "t [checked]"]);

  hook("commit-msg", "exit 1");
  seen = [];

  expect((await wrapped(["commit", "-m", "t"])).stderr).toContain("commit-msg hook failed");
  expect(seen).toEqual([]);
});

test("a commit from a message file goes to the host without reading the file", async () => {
  hook("commit-msg", "exit 1");

  const ran = await wrapped(["commit", "-F", join(root, "missing")]);

  expect(ran.code).toBe(0);
  expect(seen[0]?.body.argv).toEqual(["-C", repository, "commit", "-F", join(root, "missing")]);
});

test("a rejected commit-msg hook leaves no scratch directory behind", async () => {
  hook("commit-msg", "exit 1");

  const scratch = mkdtempSync(join(tmpdir(), "cf-stumble-git-forward-tmp-"));

  try {
    const ran = await wrapped(["commit", "-m", "t"], { TMPDIR: scratch });

    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain("commit-msg hook failed");
    expect(readdirSync(scratch)).toEqual([]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test.each([["-am", "t"], ["-mt"], ["-amt"]])(
  "a rejecting commit-msg hook stops git commit %s",
  async (...flags) => {
    hook("commit-msg", "exit 1");

    const ran = await wrapped(["commit", ...flags]);

    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain("commit-msg hook failed");
    expect(seen).toEqual([]);
  },
);

test("a commit-msg hook rewrites a message given as -am and keeps -a", async () => {
  hook("commit-msg", 'echo "$(cat "$1") [checked]" > "$1"');

  const ran = await wrapped(["commit", "-am", "t"]);

  expect(ran.code).toBe(0);
  expect(seen[0]?.body.argv).toEqual(["-C", repository, "commit", "-a", "-m", "t [checked]"]);
});

test("hooks do not run for a write that is not a commit", async () => {
  hook("pre-commit", "exit 1");

  const ran = await wrapped(["add", "."]);

  expect(ran.code).toBe(0);
  expect(seen).toHaveLength(1);
});

test("an isolate fallback is refused without asking the host", async () => {
  const ran = await wrapped(["reset", "--hard"], { CF_STUMBLE_GIT_FALLBACK: "1" });

  expect(ran.code).toBe(1);
  expect(ran.stderr).toContain("does not support this form");
  expect(seen).toEqual([]);
});

test("read forms never reach the host", async () => {
  const ran = await wrapped(["log", "--format=%s"]);

  expect(ran.stdout).toBe("first\n");
  expect(seen).toEqual([]);
});
