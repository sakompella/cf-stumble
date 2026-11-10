import { expect, test } from "vitest";
import { SETUP, shell } from "./isolate-git-shell.js";

test("git reset HEAD~1 with a single commit fails like git, with exit 128", async () => {
  const { stdout, stderr } = await shell(`${SETUP} && git reset HEAD~1; echo $?`);

  expect(stderr).toBe(
    "fatal: ambiguous argument 'HEAD~1': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'\n",
  );
  expect(stdout).toBe("128\n");
});

test("git add . in a repository with no files succeeds silently", async () => {
  const { stdout, stderr } = await shell(`git init > /dev/null && git add . ; echo $?`);

  expect(stderr).toBe("");
  expect(stdout).toBe("0\n");
});
