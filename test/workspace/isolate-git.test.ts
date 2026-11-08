import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Schema from "effect/Schema";
import { expect, test } from "vitest";
import { seedWorkspaceRoot } from "./host-fixtures.js";

const decodeEvent = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ kind: Schema.String, data: Schema.optional(Schema.String) }),
  ),
);

const SETUP = [
  "git init",
  "git config user.name Test",
  "git config user.email test@example.com",
  "echo one > a.txt",
  "echo two > b.txt",
  "git add -A",
  "git commit -q -m first",
].join(" && ");

function shell(name: string, command: string) {
  return runInDurableObject(env.WORKSPACE_HOST.getByName(name), async (host, state) => {
    await seedWorkspaceRoot(state);

    const started = await host
      .project({ remainingMs: 60_000 })
      .startExec({ command, timeoutMs: 20_000, backend: "isolate" });

    if (!started.ok) throw new Error(started.error.code);

    const lines = (await new Response(started.value.events).text()).split("\n").filter(Boolean);
    const events = lines.map((line) => decodeEvent(line));

    return {
      stdout: events
        .flatMap((event) => (event.kind === "stdout" ? [event.data] : []))
        .join("")
        .replace("Initialized empty Git repository in /workspace/.git/\n", ""),
      stderr: events.flatMap((event) => (event.kind === "stderr" ? [event.data] : [])).join(""),
    };
  });
}

test.each([
  ["untracked", "echo x > new.txt", "?? new.txt\n"],
  ["untracked directory", "mkdir d && echo x > d/x.txt", "?? d/\n"],
  ["modified", "echo x >> a.txt", " M a.txt\n"],
  ["staged", "echo x >> a.txt && git add a.txt", "M  a.txt\n"],
  ["staged and modified", "echo x >> a.txt && git add a.txt && echo y >> a.txt", "MM a.txt\n"],
  ["deleted", "rm a.txt", " D a.txt\n"],
  ["deleted and staged", "rm a.txt && git add -A", "D  a.txt\n"],
  ["added and modified", "echo x > n.txt && git add n.txt && echo y >> n.txt", "AM n.txt\n"],
  ["renamed", "mv a.txt z.txt && git add -A", "D  a.txt\nA  z.txt\n"],
])("git status -s shows %s files the way real git does", async (name, change, expected) => {
  const { stdout } = await shell(`isolate-git-${name}`, `${SETUP} && ${change} && git status -s`);

  expect(stdout).toBe(expected);
});

test("git status in the isolate prints the long format of real git", async () => {
  const { stdout } = await shell(
    "isolate-git-long",
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

test("git commit in the isolate prints the summary of real git", async () => {
  const { stdout } = await shell(
    "isolate-git-commit",
    `${SETUP} && printf 'x\\ny\\n' >> a.txt && git commit --no-verify -a -m second && git status -sb`,
  );

  expect(stdout).toMatch(
    /^\[main [0-9a-f]{7}\] second\n 1 file changed, 2 insertions\(\+\)\n## main\n$/u,
  );
});

test("the first commit in the isolate is a root commit", async () => {
  const { stdout } = await shell(
    "isolate-git-root-commit",
    "git init && git config user.name T && git config user.email t@example.com && echo one > a.txt && git add a.txt && git commit -m first",
  );

  expect(stdout).toMatch(
    /^\[main \(root-commit\) [0-9a-f]{7}\] first\n 1 file changed, 1 insertion\(\+\)\n$/u,
  );
});

test("git status in the isolate reports the upstream branch", async () => {
  const { stdout } = await shell(
    "isolate-git-upstream",
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
    "isolate-git-checkout",
    `${SETUP} && git checkout -b topic && git switch main && git checkout main && echo x >> a.txt && git checkout -- a.txt && git -c user.name=Other --no-pager branch -v`,
  );

  expect(stderr).toBe(
    [
      "Switched to a new branch 'topic'",
      "Switched to branch 'main'",
      "Already on 'main'",
      "Updated 1 path from the index",
      "",
    ].join("\n"),
  );
  expect(stdout).toMatch(/^\* main {2}[0-9a-f]{7} first\n {2}topic [0-9a-f]{7} first\n$/u);
});

test("git checkout -b in the isolate keeps local changes and commit refuses an empty index", async () => {
  const { stdout, stderr } = await shell(
    "isolate-git-dirty-branch",
    `${SETUP} && echo x >> a.txt && git checkout -b topic && git status -s && git commit -m nothing; git commit -am kept`,
  );

  expect(stderr).toBe("Switched to a new branch 'topic'\n");
  expect(stdout).toMatch(
    /^ M a\.txt\nOn branch topic\nChanges not staged for commit:\n[^]*no changes added to commit[^]*\n\[topic [0-9a-f]{7}\] kept\n 1 file changed, 1 insertion\(\+\)\n$/u,
  );
});
