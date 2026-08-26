import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { deflateSync } from "node:zlib";
import { describe, expect, it, beforeAll } from "vitest";

import {
  encodeObject,
  FILE_MODE,
  hashObject,
  parseSha,
} from "../../src/git/index.js";
import type { GitObject, Sha } from "../../src/git/index.js";

const emptyInput = new Uint8Array();
const gitEnvironment = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Oracle Author",
  GIT_AUTHOR_EMAIL: "oracle-author@example.com",
  GIT_COMMITTER_NAME: "Oracle Committer",
  GIT_COMMITTER_EMAIL: "oracle-committer@example.com",
};

beforeAll(async () => {
  await runGit(["--version"], process.cwd(), emptyInput);
});

describe("git hash-object oracle", () => {
  it("matches real git for blobs, trees, and commits", async () => {
    const objects = makeOracleObjects();
    for (const object of objects) {
      await assertHashMatchesGit(object);
    }
  });
});

describe("git loose-object repository oracle", () => {
  it("lets git log, cat-file, and ls-tree read codec-produced objects", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cf-stumble-git-"));
    try {
      await runGit(["init", "--quiet", repository], process.cwd(), emptyInput);
      const objects = await makeRepositoryObjects();
      for (const object of objects) {
        await writeLooseObject(repository, object.bytes, object.sha);
      }

      const { merge, root, second, rootTree } = repositoryReferences(objects);
      await writeFile(join(repository, ".git", "HEAD"), "ref: refs/heads/main\n");
      await mkdir(join(repository, ".git", "refs", "heads"), { recursive: true });
      await writeFile(
        join(repository, ".git", "refs", "heads", "main"),
        `${merge.sha}\n`,
      );

      const log = await runGit(
        ["--no-pager", "log", "--format=%H%n%P%n%s", "main"],
        repository,
        emptyInput,
      );
      expect(log).toContain(`${merge.sha}\n${root.sha} ${second.sha}\nmerge tree\n`);

      const commitOutput = await runGit(
        ["cat-file", "-p", merge.sha],
        repository,
        emptyInput,
      );
      expect(commitOutput).toContain(`tree ${rootTree.sha}\n`);
      expect(commitOutput).toContain(`parent ${root.sha}\nparent ${second.sha}\n`);
      expect(commitOutput).toContain("merge tree\n");

      const names = await runGit(
        ["-c", "core.quotePath=false", "ls-tree", "--name-only", merge.sha],
        repository,
        emptyInput,
      );
      expect(names).toBe("README-内容\nfoo.txt\nfoo\n");
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });
});

type RepositoryObject = {
  readonly label: string;
  readonly bytes: Uint8Array;
  readonly sha: Sha;
};

type RepositoryReferences = {
  readonly merge: RepositoryObject;
  readonly root: RepositoryObject;
  readonly second: RepositoryObject;
  readonly rootTree: RepositoryObject;
};

function repositoryReferences(
  objects: readonly RepositoryObject[],
): RepositoryReferences {
  const merge = objects.find((object) => object.label === "merge");
  const root = objects.find((object) => object.label === "root");
  const second = objects.find((object) => object.label === "second");
  const rootTree = objects.find((object) => object.label === "root tree");
  if (merge === undefined || root === undefined || second === undefined || rootTree === undefined) {
    throw new Error("test fixture is missing a repository object");
  }
  return { merge, root, second, rootTree };
}

function makeOracleObjects(): readonly GitObject[] {
  const blobSha = parseSha("0123456789012345678901234567890123456789");
  const parentSha = parseSha("1111111111111111111111111111111111111111");
  return [
    { type: "blob", data: Uint8Array.from([0, 1, 255, 0]) },
    {
      type: "tree",
      entries: [
        { mode: FILE_MODE.tree, name: "foo", sha: blobSha },
        { mode: FILE_MODE.regular, name: "foo.txt", sha: parentSha },
      ],
    },
    {
      type: "commit",
      commit: {
        tree: blobSha,
        parents: [parentSha],
        author: {
          name: "Oracle Author",
          email: "oracle@example.com",
          timestamp: 1_700_000_000,
          timezoneOffsetMinutes: -330,
        },
        committer: {
          name: "Oracle Committer",
          email: "oracle@example.com",
          timestamp: 1_700_000_001,
          timezoneOffsetMinutes: 530,
        },
        message: "unicode: 内容\n",
      },
    },
  ];
}

async function makeRepositoryObjects(): Promise<readonly RepositoryObject[]> {
  const blob = await materialize("blob", {
    type: "blob",
    data: new TextEncoder().encode("hello\0world"),
  });
  const readme = await materialize("readme", {
    type: "blob",
    data: new TextEncoder().encode("README 内容\n"),
  });
  const subtree = await materialize("subtree", {
    type: "tree",
    entries: [{ mode: FILE_MODE.regular, name: "leaf", sha: blob.sha }],
  });
  const rootTree = await materialize("root tree", {
    type: "tree",
    entries: [
      { mode: FILE_MODE.tree, name: "foo", sha: subtree.sha },
      { mode: FILE_MODE.regular, name: "foo.txt", sha: blob.sha },
      { mode: FILE_MODE.regular, name: "README-内容", sha: readme.sha },
    ],
  });
  const root = await materialize("root", commit(rootTree.sha, [], "root tree", 0));
  const second = await materialize(
    "second",
    commit(rootTree.sha, [root.sha], "second tree", 60),
  );
  const merge = await materialize(
    "merge",
    commit(rootTree.sha, [root.sha, second.sha], "merge tree", -330),
  );
  return [blob, readme, subtree, rootTree, root, second, merge];
}

function commit(
  tree: Sha,
  parents: readonly Sha[],
  message: string,
  timezoneOffsetMinutes: number,
): GitObject {
  return {
    type: "commit",
    commit: {
      tree,
      parents,
      author: {
        name: "Oracle Author",
        email: "oracle@example.com",
        timestamp: 1_700_000_000,
        timezoneOffsetMinutes,
      },
      committer: {
        name: "Oracle Committer",
        email: "oracle@example.com",
        timestamp: 1_700_000_000,
        timezoneOffsetMinutes,
      },
      message: `${message}\n`,
    },
  };
}

async function materialize(label: string, object: GitObject): Promise<RepositoryObject> {
  const bytes = encodeObject(object);
  return { label, bytes, sha: await hashObject(bytes) };
}

async function assertHashMatchesGit(object: GitObject): Promise<void> {
  const encoded = encodeObject(object);
  const expected = await runGit(
    ["hash-object", "-t", object.type, "--stdin"],
    process.cwd(),
    objectBody(encoded),
  );
  await expect(hashObject(encoded)).resolves.toBe(expected.trim());
}

async function writeLooseObject(
  repository: string,
  bytes: Uint8Array,
  sha: Sha,
): Promise<void> {
  const directory = join(repository, ".git", "objects", sha.slice(0, 2));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, sha.slice(2)), deflateSync(Buffer.from(bytes)));
}

function objectBody(bytes: Uint8Array): Uint8Array {
  const headerEnd = bytes.indexOf(0);
  if (headerEnd < 0) {
    throw new Error("test object has no header terminator");
  }
  return bytes.slice(headerEnd + 1);
}

function runGit(args: readonly string[], cwd: string, input: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: gitEnvironment });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8");
      if (code === 0) {
        resolve(output);
        return;
      }
      reject(
        new Error(
          `git ${args.join(" ")} exited ${String(code)}: ${Buffer.concat(stderr).toString("utf8")}`,
        ),
      );
    });
    child.stdin.end(Buffer.from(input));
  });
}
