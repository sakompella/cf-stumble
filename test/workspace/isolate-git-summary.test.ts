import { expect, test } from "vitest";
import { SETUP, shell } from "./isolate-git-shell.js";

test("git commit in the isolate lists created and deleted files the way real git does", async () => {
  const { stdout } = await shell(
    `${SETUP} && echo n > n.txt && git add n.txt && rm b.txt && git add -A && git commit -m second`,
  );

  expect(stdout).toMatch(
    /^\[main [0-9a-f]{7}\] second\n 2 files changed, 1 insertion\(\+\), 1 deletion\(-\)\n delete mode 100644 b.txt\n create mode 100644 n.txt\n$/u,
  );
});

test("git branch on a detached HEAD lists the detached commit first", async () => {
  const { stdout, stderr } = await shell(
    `${SETUP} && git log --format=%H -1 > .git/HEAD && git branch && git branch -v`,
  );

  expect(stderr).toBe("");

  expect(stdout).toMatch(
    /^\* \(HEAD detached at ([0-9a-f]{7})\)\n {2}main\n\* \(HEAD detached at \1\) \1 first\n {2}main {23}\1 first\n$/u,
  );
});

test("git reset --hard reports the new HEAD", async () => {
  const { stdout } = await shell(
    `${SETUP} && echo x >> a.txt && git add a.txt && git reset --hard && git status -s`,
  );

  expect(stdout).toMatch(/^HEAD is now at [0-9a-f]{7} first\n$/u);
});
