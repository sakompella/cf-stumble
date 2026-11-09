import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { branchTracking } from "../../../src/workspace/project/git-tracking.js";

const directories: string[] = [];

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("counts commits on every side of a merged history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "git-tracking-"));
  directories.push(dir);
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  const commit = (name: string, seconds: number): string => {
    writeFileSync(join(dir, "history"), name);
    git("add", "history");
    const date = `2020-01-01T00:00:${String(seconds).padStart(2, "0")}Z`;
    return execFileSync(
      "git",
      ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@e", "commit", "-m", name],
      {
        encoding: "utf8",
        env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      },
    ).trim();
  };
  git("init", "-b", "main");
  commit("A", 1);
  const a = git("rev-parse", "HEAD");
  commit("L", 2);
  git("branch", "side", a);
  git("checkout", "side");
  commit("C", 3);
  const c = git("rev-parse", "HEAD");
  git("checkout", "main");
  git("merge", "--no-ff", "side", "-m", "M");
  const local = git("log", "--format=%H", "main").split("\n");
  const upstream = git("log", "--format=%H", c).split("\n");
  git("update-ref", "refs/remotes/origin/main", c);
  expect(git("rev-list", "--left-right", "--count", "main...origin/main")).toBe("2\t0");
  expect(local[0]).toBe(git("rev-parse", "HEAD"));
  const fake = {
    configGet: async ({ path }: { path: string }) =>
      path.endsWith(".remote") ? "origin" : "refs/heads/main",
    revParse: async ({ ref }: { ref: string }) =>
      ref === "refs/heads/main" ? (local[0] ?? "") : c,
    log: async ({ ref }: { ref: string }) =>
      (ref === local[0] ? local : upstream).map((oid) => ({
        oid,
        message: "",
        tree: "",
        parent: [],
        author: { name: "T", email: "t@e", timestamp: 1, timezoneOffset: 0 },
        committer: { name: "T", email: "t@e", timestamp: 1, timezoneOffset: 0 },
      })),
  };
  const result = await branchTracking(fake, dir, "main");
  expect(result).toMatchObject({ ahead: 2, behind: 0 });
  expect(a).not.toBe(c);
});
