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

interface MergedHistory {
  readonly tip: string;
  readonly local: readonly string[];
  readonly upstream: readonly string[];
}

function mergedHistory(dir: string): MergedHistory {
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@e", ...args], {
      encoding: "utf8",
    }).trim();

  const commit = (name: string, seconds: number, file = "history"): void => {
    writeFileSync(join(dir, file), name);
    git("add", file);

    const date = `2020-01-01T00:00:${String(seconds).padStart(2, "0")}Z`;

    execFileSync(
      "git",
      ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@e", "commit", "-m", name],
      {
        encoding: "utf8",
        env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      },
    );
  };

  git("init", "-b", "main");
  commit("A", 1);
  const fork = git("rev-parse", "HEAD");
  commit("L", 2);
  git("branch", "side", fork);
  git("checkout", "side");
  commit("C", 3, "side");
  const tip = git("rev-parse", "HEAD");
  git("checkout", "main");
  git("merge", "--no-ff", "side", "-m", "M");

  return {
    tip,
    local: git("log", "--format=%H", "main").split("\n"),
    upstream: git("log", "--format=%H", tip).split("\n"),
  };
}

it("counts commits on every side of a merged history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "git-tracking-"));
  directories.push(dir);

  const { tip, local, upstream } = mergedHistory(dir);

  execFileSync("git", ["-C", dir, "update-ref", "refs/remotes/origin/main", tip]);
  expect(
    execFileSync("git", ["-C", dir, "rev-list", "--left-right", "--count", "main...origin/main"], {
      encoding: "utf8",
    }).trim(),
  ).toBe("2\t0");

  const fake = {
    configGet: ({ path }: { path: string }) =>
      Promise.resolve(path.endsWith(".remote") ? "origin" : "refs/heads/main"),
    revParse: ({ ref }: { ref: string }) =>
      Promise.resolve(ref === "refs/heads/main" ? (local[0] ?? "") : tip),
    log: ({ ref }: { ref: string }) =>
      Promise.resolve(
        (ref === local[0] ? local : upstream).map((oid) => ({
          oid,
          message: "",
          tree: "",
          parent: [],
          author: { name: "T", email: "t@e", timestamp: 1, timezoneOffset: 0 },
          committer: { name: "T", email: "t@e", timestamp: 1, timezoneOffset: 0 },
        })),
      ),
  };

  const result = await branchTracking(fake, dir, "main");

  expect(result).toMatchObject({ ahead: 2, behind: 0 });
});
