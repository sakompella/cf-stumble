import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { routedBackend } from "../src/workspace/project/exec-routing.ts";
import { justBashOutputs } from "./just-bash-outputs.mts";

const FILES = {
  "a.txt": "hello\nworld\n",
  "b.txt": "x\n",
  "sub/x.txt": "x\n",
  "csv.txt": "a,b\nc\n",
  "dup.txt": "a\na\nb\n",
  "ü.txt": "u\n",
  "é/x": "e\n",
};

const COMMANDS = [
  "ls",
  "ls -a sub",
  "ls a.txt b.txt",
  "ls a.txt missing",
  "ls sub a.txt",
  "cut -d, -f2 csv.txt",
  "cut -f2 a.txt",
  "cut -c1-3 a.txt",
  "chmod +x a.txt && ls -l a.txt",
  "echo -e 'a\\nb'",
  "echo -n hi",
  "echo hi",
  "cat a.txt | wc",
  "wc a.txt",
  "wc -l a.txt b.txt",
  "wc -l < a.txt",
  "cat a.txt | wc -l",
  "sort dup.txt | uniq -c",
  "uniq dup.txt",
  "cat missing a.txt > out 2>&1; cat out",
  "cat missing a.txt 2>&1 | cat",
  "grep -r hello .",
  "grep -rn hello .",
  "grep -r hello",
  "grep hello a.txt",
  "du -a sub",
  "echo hi > nodir/x; echo after",
  "head -n1 a.txt",
  "sed -n 1p a.txt",
  "find . -type f | sort | wc -w",
  "tr a-z A-Z < a.txt",
  "awk '{print $1}' a.txt",
  "awk 'BEGIN{for(i=0;i<3;i++)print i}'",
  "echo *.txt",
  "echo ??.txt",
  "echo ?.txt",
  "echo [a-z].txt",
  "echo [ü].txt",
  "echo ?/x",
  "grep '[a-z]*' a.txt",
  "ls ü.txt",
  "cat ü.txt",
  "sha256sum a.txt",
  "sha256sum missing | tac",
  "sha1sum missing a.txt",
  "md5sum missing",
];

function fixtureDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "isolate-parity-"));

  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  }

  return directory;
}

function dashOutput(command: string) {
  const directory = fixtureDirectory();

  const run = spawnSync("dash", ["-c", command], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });

  rmSync(directory, { recursive: true, force: true });

  return { stdout: run.stdout, exitCode: run.status };
}

describe("a command that the router sends to the isolate prints what dash and GNU tools print", () => {
  const isolated = COMMANDS.filter((command) => routedBackend(command) === "isolate");
  const shell = justBashOutputs(FILES, isolated);
  const real = isolated.map(dashOutput);

  isolated.forEach((command, index) => {
    it(command, () => {
      assert.deepEqual(shell[index], real[index]);
    });
  });

  it("sends the commands whose output differs to the container", () => {
    assert.deepEqual(
      COMMANDS.filter((command) => routedBackend(command) === "container"),
      [
        "ls a.txt b.txt",
        "ls a.txt missing",
        "ls sub a.txt",
        "cut -d, -f2 csv.txt",
        "cut -f2 a.txt",
        "chmod +x a.txt && ls -l a.txt",
        "echo -e 'a\\nb'",
        "cat a.txt | wc",
        "wc a.txt",
        "wc -l a.txt b.txt",
        "sort dup.txt | uniq -c",
        "cat missing a.txt > out 2>&1; cat out",
        "cat missing a.txt 2>&1 | cat",
        "grep -r hello .",
        "grep -rn hello .",
        "grep -r hello",
        "du -a sub",
        "awk 'BEGIN{for(i=0;i<3;i++)print i}'",
        "echo ??.txt",
        "echo ?.txt",
        "echo [a-z].txt",
        "echo [ü].txt",
        "echo ?/x",
        "sha256sum a.txt",
        "sha256sum missing | tac",
        "sha1sum missing a.txt",
        "md5sum missing",
      ],
    );
  });
});
