import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { devShellTool } from "../dev-shell-tool.js";
import { git } from "./rooted-shell.js";

const WRAPPER = new URL("../../infra/workspace-image/git-readonly.sh", import.meta.url).pathname;

let root = "";

let repository = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cf-stumble-git-readonly-"));
  repository = join(root, "repository");
  git(root, "init", "-q", "-b", "main", "repository");
  git(repository, "commit", "-q", "--allow-empty", "-m", "first");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function wrapped(args: readonly string[], environment: Record<string, string> = {}) {
  return spawnSync(devShellTool("dash"), [WRAPPER, "-C", repository, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CF_STUMBLE_REAL_GIT: devShellTool("git"),
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      ...environment,
    },
  });
}

test.each([
  ["status", "--short"],
  ["log", "--oneline"],
  ["rev-parse", "HEAD"],
  ["config", "--get", "core.bare"],
  ["config", "core.bare"],
  ["branch"],
  ["branch", "--list", "ma*"],
  ["tag", "-l"],
  ["remote", "-v"],
  ["stash", "list"],
])("runs the read-only git %s", (...args) => {
  const ran = wrapped(args);

  expect(ran.stderr).toBe("");
  expect(ran.status).toBe(0);
});

test.each([
  ["commit", "--allow-empty", "-m", "second"],
  ["branch", "feature"],
  ["branch", "-D", "main"],
  ["tag", "v1"],
  ["config", "user.name", "someone"],
  ["remote", "add", "origin", "https://example.invalid/repo.git"],
  ["reset", "--hard"],
  ["stash"],
])("refuses git %s and leaves .git as it was", (...args) => {
  const before = git(repository, "for-each-ref");

  const ran = wrapped(args);

  expect(ran.status).toBe(1);
  expect(ran.stderr).toContain(`git ${args[0] ?? ""} changes .git`);
  expect(git(repository, "for-each-ref")).toBe(before);
  expect(git(repository, "config", "--local", "--list")).not.toContain("user.name");
});

test("clones into a new directory", () => {
  const ran = wrapped(["clone", "-q", repository, join(root, "copy")]);

  expect(ran.status, ran.stderr).toBe(0);
  expect(git(join(root, "copy"), "log", "--format=%s")).toBe("first");
});

test("an explicit write switch lets provisioning write", () => {
  const ran = wrapped(["config", "core.fileMode", "false"], {
    CF_STUMBLE_CONTAINER_GIT_WRITE: "1",
  });

  expect(ran.status, ran.stderr).toBe(0);
  expect(git(repository, "config", "core.fileMode")).toBe("false");
});
