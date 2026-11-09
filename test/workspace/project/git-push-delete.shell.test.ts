import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { pushDelete } from "../../../src/workspace/project/git-index-commands.js";

const directories: string[] = [];

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface RemoteLayout {
  readonly workspace: string;
  readonly origin: string;
}

function setupOriginWithTopic(): RemoteLayout {
  const root = mkdtempSync(join(tmpdir(), "git-push-delete-"));
  directories.push(root);

  const origin = join(root, "origin");
  const workspace = join(root, "workspace");

  execFileSync("git", ["init", "-q", "-b", "main", origin]);
  execFileSync("git", [
    "-C",
    origin,
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@e",
    "commit",
    "--allow-empty",
    "-q",
    "-m",
    "first",
  ]);
  execFileSync("git", ["clone", "-q", `file://${origin}`, workspace]);
  execFileSync("git", ["-C", workspace, "push", "-q", "origin", "main:refs/heads/topic"]);

  return { workspace, origin };
}

it("the pushDelete rewrite deletes the remote branch through real git", () => {
  const { workspace, origin } = setupOriginWithTopic();

  const rewritten = pushDelete({ argv: ["push", "origin", ":topic"], cwd: workspace });
  const pushed = spawnSync("git", ["-C", workspace, ...rewritten.argv], { encoding: "utf8" });

  expect(pushed.status).toBe(0);
  expect(
    spawnSync("git", ["-C", origin, "rev-parse", "--verify", "refs/heads/topic"], {
      encoding: "utf8",
    }).status,
  ).not.toBe(0);
});

it("the pushDelete rewrite of a branch the remote lacks fails with git's own error", () => {
  const { workspace } = setupOriginWithTopic();

  const rewritten = pushDelete({ argv: ["push", "origin", ":missing"], cwd: workspace });
  const pushed = spawnSync("git", ["-C", workspace, ...rewritten.argv], { encoding: "utf8" });

  expect(pushed.status).not.toBe(0);
  expect(pushed.stderr).toContain("remote ref does not exist");
});
