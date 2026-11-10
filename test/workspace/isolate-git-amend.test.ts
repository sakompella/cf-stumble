import { expect, test } from "vitest";
import { SETUP, shell } from "./isolate-git-shell.js";

test("git commit --amend --no-edit keeps the message and folds in the staged change", async () => {
  const { stdout, stderr } = await shell(
    `${SETUP} && echo y >> a.txt && git add a.txt && git commit -q --amend --no-edit && git log --format=%s && git status -s`,
  );

  expect(stderr).toBe("");
  expect(stdout).toBe("first\n");
});

test("git commit --amend --no-edit with no commit has nothing to amend", async () => {
  const { stdout, stderr } = await shell(
    `git init > /dev/null && git commit --amend --no-edit; echo $?`,
  );

  expect(stderr).toBe("fatal: You have nothing to amend.\n");
  expect(stdout).toBe("128\n");
});
