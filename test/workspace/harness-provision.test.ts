import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { HARNESS_BUILD_CONFIGURATION } from "../../src/harness-build.js";
import type { HarnessCommit } from "../../src/harness-commit.js";
import { provisionHarness } from "../../src/workspace/harness-provision.js";
import type { CommandOutput } from "../../src/workspace/operations.js";
import { testHarnessCommit } from "../harness-commit-fixtures.js";

const ROOT = HARNESS_BUILD_CONFIGURATION.harnessRepositoryRoot;

const REMOTE = HARNESS_BUILD_CONFIGURATION.harnessGitRemote;

const history = Array.from({ length: 1_000 }, (_, index) =>
  testHarnessCommit(index.toString(16).padStart(40, "a")),
);

function commitAt(index: number): HarnessCommit {
  return history[index] ?? testHarnessCommit("7".repeat(40));
}

const person = { name: "a", email: "a@example.com", timestamp: 0, timezoneOffset: 0 };

type Repository = {
  origin: string;
  commits: Set<string>;
};

function notFound(): Promise<never> {
  return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
}

function dirent(name: string) {
  return {
    name,
    parentPath: ROOT,
    size: 0,
    mtime: 0,
    isFile: true,
    isDirectory: false,
    isSymbolicLink: false,
  };
}

class FakeHarnessWorkspace {
  readonly calls: string[] = [];
  repository: Repository | undefined;
  staged: Repository | undefined;
  strayFiles: string[] = [];
  containerOutput: CommandOutput = { stdout: "", stderr: "", exitCode: 0 };

  cloned(origin: string = REMOTE, depth = 50): this {
    this.repository = repository(origin, depth);

    return this;
  }

  private present(): Repository {
    if (this.repository === undefined) throw new Error("not a repository");

    return this.repository;
  }

  readonly fs = {
    readFile: notFound,
    readdir: (path: string) =>
      path === ROOT && this.strayFiles.length > 0
        ? Promise.resolve(this.strayFiles.map(dirent))
        : notFound(),
    stat: (path: string) =>
      path === HARNESS_BUILD_CONFIGURATION.harnessGitDir && this.repository !== undefined
        ? Promise.resolve({ ...dirent(".git"), inode: 1, mode: 0o755, isDirectory: true })
        : notFound(),
    rm: (path: string) => {
      this.calls.push(`rm ${path}`);

      return Promise.resolve();
    },
    mkdir: () => Promise.resolve(),
    rename: (from: string, to: string) => {
      this.calls.push(`rename ${from} ${to}`);
      this.repository = this.staged;

      return Promise.resolve();
    },
  };

  readonly git = {
    clone: (options: { url: string; dir?: string; depth?: number }) => {
      this.calls.push(`clone ${options.url} ${options.dir ?? ""} ${String(options.depth)}`);
      this.staged = repository(options.url, options.depth ?? 1);

      return Promise.resolve();
    },
    configSet: (options: { path: string; value: unknown }) => {
      this.calls.push(`config ${options.path}=${String(options.value)}`);

      return Promise.resolve();
    },
    configGet: () => Promise.resolve(this.present().origin),
    show: (options: { ref: string }) =>
      this.present().commits.has(options.ref)
        ? Promise.resolve({
            oid: options.ref,
            message: "",
            tree: "",
            parent: [],
            author: person,
            committer: person,
          })
        : Promise.reject(new Error("missing commit")),
  };

  readonly container = (source: string) => {
    this.calls.push(source.includes("merge --ff-only") ? "container advance" : "container fetch");

    return Effect.succeed(this.containerOutput);
  };
}

function repository(origin: string, depth: number): Repository {
  return { origin, commits: new Set(history.slice(0, depth)) };
}

function provision(workspace: FakeHarnessWorkspace, commit: HarnessCommit) {
  return Effect.runPromise(
    provisionHarness(workspace, workspace.container, HARNESS_BUILD_CONFIGURATION, commit),
  );
}

const ok = { stdout: "", stderr: "", exitCode: 0 };

test("clones a missing harness through a staging directory, then advances it in the container", async () => {
  const workspace = new FakeHarnessWorkspace();

  await expect(provision(workspace, commitAt(3))).resolves.toEqual(ok);
  expect(workspace.calls).toEqual([
    `rm ${ROOT}`,
    `rm ${ROOT}.provisioning`,
    `clone ${REMOTE} ${ROOT}.provisioning 50`,
    "config core.fileMode=false",
    `rename ${ROOT}.provisioning ${ROOT}`,
    "container advance",
  ]);
});

test("refuses a populated directory that is not a repository", async () => {
  const workspace = new FakeHarnessWorkspace();
  workspace.strayFiles = ["owned.txt"];

  const result = await provision(workspace, commitAt(0));

  expect(result).toEqual({
    stdout: "",
    stderr: `${ROOT} is not a git repository and is not empty\n`,
    exitCode: 1,
  });
  expect(workspace.calls).toEqual([]);
});

test("refuses a checkout whose origin is another repository", async () => {
  const workspace = new FakeHarnessWorkspace().cloned("https://github.com/someone/else.git");

  const result = await provision(workspace, commitAt(0));

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe(`${ROOT} has a different origin than ${REMOTE}\n`);
  expect(workspace.calls).toEqual([]);
});

test("fetches a commit the checkout lacks by its id in the container", async () => {
  const workspace = new FakeHarnessWorkspace().cloned();

  await expect(provision(workspace, commitAt(600))).resolves.toEqual(ok);
  expect(workspace.calls).toEqual(["container fetch", "container advance"]);
});

test("fails naming the commit, the remote and Git's reason when the container cannot fetch it", async () => {
  const workspace = new FakeHarnessWorkspace().cloned();
  const absent = testHarnessCommit("f".repeat(40));
  workspace.containerOutput = {
    stdout: "",
    stderr: "fatal: remote error: upload-pack: not our ref\n",
    exitCode: 128,
  };

  await expect(provision(workspace, absent)).resolves.toEqual({
    stdout: "",
    stderr: `harness commit ${absent} is not in ${REMOTE}: fatal: remote error: upload-pack: not our ref\n`,
    exitCode: 1,
  });
});

test("reports what the container's advance of the checkout says", async () => {
  const workspace = new FakeHarnessWorkspace().cloned();
  const message = `harness checkout has local changes; left at ${commitAt(0).slice(0, 7)}\n`;
  workspace.containerOutput = { stdout: "", stderr: message, exitCode: 0 };

  await expect(provision(workspace, commitAt(0))).resolves.toEqual({
    stdout: "",
    stderr: message,
    exitCode: 0,
  });
  expect(workspace.calls).toEqual(["container advance"]);
});
