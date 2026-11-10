import { expect, test } from "vitest";
import { SETUP, shell } from "./isolate-git-shell.js";

test.each([
  ["untracked", "echo x > new.txt", "?? new.txt\n"],
  ["untracked directory", "mkdir d && echo x > d/x.txt", "?? d/\n"],
  ["modified", "echo x >> a.txt", " M a.txt\n"],
  ["staged", "echo x >> a.txt && git add a.txt", "M  a.txt\n"],
  ["staged and modified", "echo x >> a.txt && git add a.txt && echo y >> a.txt", "MM a.txt\n"],
  ["deleted", "rm a.txt", " D a.txt\n"],
  ["deleted and staged", "rm a.txt && git add -A", "D  a.txt\n"],
  ["added and modified", "echo x > n.txt && git add n.txt && echo y >> n.txt", "AM n.txt\n"],
  ["renamed", "mv a.txt z.txt && git add -A", "R  a.txt -> z.txt\n"],
])("git status -s shows %s files the way real git does", async (_name, change, expected) => {
  const { stdout } = await shell(`${SETUP} && ${change} && git status -s`);

  expect(stdout).toBe(expected);
});

test("git status in the isolate prints the long format of real git", async () => {
  const { stdout } = await shell(
    `${SETUP} && echo x >> a.txt && git add a.txt && rm b.txt && echo x > c.txt && git status`,
  );

  expect(stdout).toBe(
    [
      "On branch main",
      "Changes to be committed:",
      '  (use "git restore --staged <file>..." to unstage)',
      "\tmodified:   a.txt",
      "",
      "Changes not staged for commit:",
      '  (use "git add/rm <file>..." to update what will be committed)',
      '  (use "git restore <file>..." to discard changes in working directory)',
      "\tdeleted:    b.txt",
      "",
      "Untracked files:",
      '  (use "git add <file>..." to include in what will be committed)',
      "\tc.txt",
      "",
      "",
    ].join("\n"),
  );
});

test("git commit treats a flag-looking message value as the message", async () => {
  const { stdout } = await shell(
    `${SETUP} && echo x >> a.txt && git add a.txt && git commit -m -q && git log -1 --format=%s`,
  );

  expect(stdout).toMatch(/\[main [0-9a-f]{7}\] -q\n/u);
});

test("git -c rejects a setting the adapter does not support", async () => {
  const { stdout, stderr } = await shell(
    `${SETUP} && git -c core.fileMode=false status -s && echo ok`,
  );

  expect(stdout).toBe("");
  expect(stderr).toContain("error: unsupported -c setting 'core.fileMode'");
});

test("git status --porcelain=v2 is refused instead of approximated", async () => {
  const { stdout, stderr } = await shell(
    `${SETUP} && echo x >> a.txt && git status --porcelain=v2 && echo ok`,
  );

  expect(stdout).toBe("");
  expect(stderr).toContain("error: --porcelain=v2 is not implemented");
});

test("git status from a subdirectory shows paths relative to it", async () => {
  const { stdout } = await shell(
    `${SETUP} && mkdir sub && echo x >> a.txt && cd sub && echo n > n.txt && git status -s`,
  );

  expect(stdout).toBe(" M ../a.txt\n?? ./\n");
});

test("git status from a subdirectory shows a rename with paths relative to it", async () => {
  const { stdout } = await shell(
    `${SETUP} && mkdir sub && mv a.txt sub/a.txt && git add -A && cd sub && git status -s`,
  );

  expect(stdout).toBe("R  ../a.txt -> a.txt\n");
});

test("git add . from a subdirectory stages only the subtree", async () => {
  const { stdout } = await shell(
    `${SETUP} && mkdir sub && echo x >> a.txt && cd sub && echo n > n.txt && git add . && cd .. && git status -s`,
  );

  expect(stdout).toBe(" M a.txt\nA  sub/n.txt\n");
});

test("git add -u from a subdirectory stages the whole tree", async () => {
  const { stdout } = await shell(
    `${SETUP} && mkdir sub && cd sub && echo x >> ../a.txt && git add -u && cd .. && git status -s`,
  );

  expect(stdout).toBe("M  a.txt\n");
});

test("git restore --staged from a subdirectory unstages the rooted path", async () => {
  const { stdout } = await shell(
    `${SETUP} && mkdir sub && cd sub && echo x >> ../a.txt && git add ../a.txt && git status -s && git restore --staged ../a.txt && git status -s`,
  );

  expect(stdout).toBe("M  ../a.txt\n M ../a.txt\n");
});

test("git commit from a subdirectory commits the staged tree", async () => {
  const { stdout } = await shell(
    `${SETUP} && mkdir sub && cd sub && echo n > n.txt && git add . && git commit -q -m from-sub && cd .. && git log -1 --format=%s`,
  );

  expect(stdout).toBe("from-sub\n");
});

test("git commit with a pathspec from a subdirectory is refused", async () => {
  const { stdout, stderr } = await shell(
    `${SETUP} && mkdir sub && cd sub && git commit -q -m x ../a.txt && echo ok`,
  );

  expect(stdout).toBe("");
  expect(stderr).toContain("fatal: pathspec arguments are not supported from a subdirectory");
});

test("git commit in the isolate prints the summary of real git", async () => {
  const { stdout } = await shell(
    `${SETUP} && printf 'x\\ny\\n' >> a.txt && git commit --no-verify -a -m second && git status -sb`,
  );

  expect(stdout).toMatch(
    /^\[main [0-9a-f]{7}\] second\n 1 file changed, 2 insertions\(\+\)\n## main\n$/u,
  );
});

test("the first commit in the isolate is a root commit", async () => {
  const { stdout } = await shell(
    "git init && git config user.name T && git config user.email t@example.com && echo one > a.txt && git add a.txt && git commit -m first",
  );

  expect(stdout).toMatch(
    /^\[main \(root-commit\) [0-9a-f]{7}\] first\n 1 file changed, 1 insertion\(\+\)\n create mode 100644 a\.txt\n$/u,
  );
});

test("git status in the isolate reports the upstream branch", async () => {
  const { stdout } = await shell(
    `${SETUP} && git update-ref refs/remotes/origin/main HEAD && git config branch.main.remote origin && git config branch.main.merge refs/heads/main && echo x >> a.txt && git commit -q -am second && git status -sb && git status && git branch -vv`,
  );

  expect(stdout).toMatch(
    new RegExp(
      [
        "^## main...origin/main \\[ahead 1\\]",
        "On branch main",
        "Your branch is ahead of 'origin/main' by 1 commit\\.",
        '  \\(use "git push" to publish your local commits\\)',
        "",
        "nothing to commit, working tree clean",
        "\\* main [0-9a-f]{7} \\[origin/main: ahead 1\\] second\n$",
      ].join("\n"),
      "u",
    ),
  );
});

test("git checkout in the isolate prints the messages of real git", async () => {
  const { stdout, stderr } = await shell(
    `${SETUP} && git checkout -b topic && git switch main && git checkout main && echo x >> a.txt && git checkout -- a.txt && git status -s && git -c user.name=Other --no-pager branch -v`,
  );

  expect(stderr).toBe(
    ["Switched to a new branch 'topic'", "Switched to branch 'main'", "Already on 'main'", ""].join(
      "\n",
    ),
  );
  expect(stdout).toMatch(/^\* main {2}[0-9a-f]{7} first\n {2}topic [0-9a-f]{7} first\n$/u);
});

test("git checkout -b in the isolate keeps local changes and commit refuses an empty index", async () => {
  const { stdout, stderr } = await shell(
    `${SETUP} && echo x >> a.txt && git checkout -b topic && git status -s && git commit -m nothing; git commit -am kept`,
  );

  expect(stderr).toBe("Switched to a new branch 'topic'\n");
  expect(stdout).toMatch(
    /^ M a\.txt\nOn branch topic\nChanges not staged for commit:\n[^]*no changes added to commit[^]*\n\[topic [0-9a-f]{7}\] kept\n 1 file changed, 1 insertion\(\+\)\n$/u,
  );
});

test("git add -u stages changes and deletions of tracked files only", async () => {
  const { stdout } = await shell(
    `${SETUP} && echo x >> a.txt && rm b.txt && echo y > c.txt && git add -u && git status -s`,
  );

  expect(stdout).toBe("M  a.txt\nD  b.txt\n?? c.txt\n");
});

test("git add -u stages a file modified again after staging", async () => {
  const { stdout } = await shell(
    `${SETUP} && echo x >> a.txt && git add a.txt && echo y >> a.txt && git add -u && git status -s`,
  );

  expect(stdout).toBe("M  a.txt\n");
});

test("git add -u stages a staged new file modified again", async () => {
  const { stdout } = await shell(
    `${SETUP} && echo x > n.txt && git add n.txt && echo y >> n.txt && git add -u && git status -s`,
  );

  expect(stdout).toBe("A  n.txt\n");
});

test("git add . stages new files and deletions", async () => {
  const { stdout } = await shell(
    `${SETUP} && echo y > c.txt && rm b.txt && git add . && git status -s`,
  );

  expect(stdout).toBe("D  b.txt\nA  c.txt\n");
});

test("git reset --soft moves the branch and keeps the index", async () => {
  const { stdout } = await shell(
    `${SETUP} && echo x >> a.txt && git commit -q -am second && git reset --soft HEAD~1 && git status -s && git log --oneline | wc -l`,
  );

  expect(stdout).toBe("M  a.txt\n1\n");
});

test("git reset and git reset --mixed unstage and move the branch", async () => {
  const { stdout } = await shell(
    `${SETUP} && echo x >> a.txt && git add a.txt && git reset && git status -s && git add a.txt && git commit -q -m second && git reset --mixed HEAD~1 && git status -s && git log --oneline | wc -l`,
  );

  const unstaged = "Unstaged changes after reset:\nM\ta.txt\n";

  expect(stdout).toBe(`${unstaged} M a.txt\n${unstaged} M a.txt\n1\n`);
});

test("git reset <paths> and git restore --staged unstage only those paths", async () => {
  const { stdout } = await shell(
    `${SETUP} && echo x >> a.txt && echo x >> b.txt && git add -A && git reset a.txt && git status -s && git restore --staged b.txt && git status -s`,
  );

  expect(stdout).toBe(
    "Unstaged changes after reset:\nM\ta.txt\n M a.txt\nM  b.txt\n M a.txt\n M b.txt\n",
  );
});

test("git reset to an unknown revision fails with a message", async () => {
  const { stderr } = await shell(`${SETUP} && git reset --soft nope`);

  expect(stderr).toContain("unknown revision");
});

test("git restore of a staged path refuses instead of unstaging", async () => {
  const { stdout, stderr } = await shell(
    `${SETUP} && echo x >> a.txt && git add a.txt && echo y >> a.txt && git restore a.txt; git status -s`,
  );

  expect(stderr).toContain("has staged changes");
  expect(stdout).toBe("MM a.txt\n");
});

test("git restore discards working-tree changes of tracked files", async () => {
  const { stdout, stderr } = await shell(
    `${SETUP} && echo x >> a.txt && rm b.txt && git restore . && git status -s && cat a.txt && cat b.txt`,
  );

  expect(stderr).toBe("");
  expect(stdout).toBe("one\ntwo\n");
});

test("git restore --staged --source resets the index to the source revision", async () => {
  const { stdout } = await shell(
    `${SETUP} && echo x >> a.txt && git commit -q -am second && echo y >> a.txt && git add a.txt && git restore --staged --source HEAD~1 a.txt && git status -s`,
  );

  expect(stdout).toBe("MM a.txt\n");
});
