import { expect, test } from "vitest";
import { SETUP, shell } from "./isolate-git-shell.js";

test("git rm deletes the file from the index and the working tree like real git", async () => {
  const { stdout, stderr } = await shell(`${SETUP} && git rm a.txt && ls && git status -s`);

  expect(stderr).toBe("");
  expect(stdout).toBe("rm 'a.txt'\nb.txt\nD  a.txt\n");
});

test("git rm --cached keeps the working-tree file", async () => {
  const { stdout } = await shell(`${SETUP} && git rm -q --cached a.txt && ls && cat a.txt`);

  expect(stdout).toBe("a.txt\nb.txt\none\n");
});

test("git rm of a path git does not track fails with exit 128", async () => {
  const { stdout, stderr } = await shell(`${SETUP} && git rm nope.txt; echo $?`);

  expect(stderr).toBe("fatal: pathspec 'nope.txt' did not match any files\n");
  expect(stdout).toBe("128\n");
});

test("git rm needs -r for a directory and then removes the emptied directory", async () => {
  const { stdout, stderr } = await shell(
    `${SETUP} && mkdir -p d/e && echo x > d/e/f && git add d && git commit -q -m d && git rm d; git rm -r d && ls`,
  );

  expect(stderr).toBe("fatal: not removing 'd' recursively without -r\n");
  expect(stdout).toBe("rm 'd/e/f'\na.txt\nb.txt\n");
});

test("git rm refuses a file with local modifications unless forced", async () => {
  const { stdout, stderr } = await shell(
    `${SETUP} && echo y >> a.txt && git rm a.txt; echo $? && git rm -f a.txt && ls`,
  );

  expect(stderr).toBe(
    [
      "error: the following file has local modifications:",
      "    a.txt",
      "(use --cached to keep the file, or -f to force removal)",
      "",
    ].join("\n"),
  );
  expect(stdout).toBe("1\nrm 'a.txt'\nb.txt\n");
});

test("git rm refuses a file whose staged content differs from the file and HEAD", async () => {
  const { stderr } = await shell(
    `${SETUP} && echo y >> a.txt && git add a.txt && echo z >> a.txt && git rm --cached a.txt`,
  );

  expect(stderr).toBe(
    [
      "error: the following file has staged content different from both the",
      "file and the HEAD:",
      "    a.txt",
      "(use -f to force removal)",
      "",
    ].join("\n"),
  );
});

test("git rm from a subdirectory removes the file relative to it", async () => {
  const { stdout } = await shell(
    `${SETUP} && mkdir sub && echo q > sub/z && git add sub && git commit -q -m s && cd sub && git rm z && git status -s`,
  );

  expect(stdout).toBe("rm 'sub/z'\nD  z\n");
});

test("git rm expands a wildcard pathspec over tracked files, with -r not needed", async () => {
  const { stdout, stderr } = await shell(
    `${SETUP} && mkdir d && echo x > d/c.txt && echo y > d/c.md && git add d && git commit -q -m d && git rm -q '*.txt' && git ls-files`,
  );

  expect(stderr).toBe("");
  expect(stdout).toBe("d/c.md\n");
});

test("git rm with a wildcard that matches nothing fails with exit 128", async () => {
  const { stdout, stderr } = await shell(`${SETUP} && git rm '*.rs'; echo $?`);

  expect(stderr).toBe("fatal: pathspec '*.rs' did not match any files\n");
  expect(stdout).toBe("128\n");
});
