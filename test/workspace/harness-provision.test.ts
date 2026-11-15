import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { HARNESS_BUILD_CONFIGURATION } from "../../src/harness-build.js";
import type { HarnessCommit } from "../../src/harness-commit.js";
import { provisionHarness } from "../../src/workspace/harness-provision.js";
import type { CommandOutput } from "../../src/workspace/operations.js";
import { eventually } from "../eventually.js";
import { testHarnessCommit } from "../harness-commit-fixtures.js";
import { runInterruptible } from "./workspace-results.js";

const ROOT = HARNESS_BUILD_CONFIGURATION.harnessRepositoryRoot;

const REMOTE = HARNESS_BUILD_CONFIGURATION.harnessGitRemote;

const history = Array.from({ length: 1_000 }, (_, index) =>
  testHarnessCommit(index.toString(16).padStart(40, "a")),
);

function commitAt(index: number): HarnessCommit {
  return history[index] ?? testHarnessCommit("7".repeat(40));
}

const person = { name: "a", email: "a@example.com", timestamp: 0, timezoneOffset: 0 };

type Checkout = {
  origin: string;
  commits: Set<string>;
  head: string;
  config: Map<string, unknown>;
};

function checkoutOf(origin: string, depth: number): Checkout {
  const commits = history.slice(0, depth);

  return { origin, commits: new Set(commits), head: commits.at(-1) ?? "", config: new Map() };
}

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
  readonly checkouts = new Map<string, Checkout>();
  readonly strays = new Map<string, string[]>();
  containerRuns = 0;
  fetchedCommit: string | undefined;
  cloneHangs = false;
  containerOutput: CommandOutput = { stdout: "", stderr: "", exitCode: 0 };

  cloned(origin: string = REMOTE, depth = 50): this {
    this.checkouts.set(ROOT, checkoutOf(origin, depth));

    return this;
  }

  paths(): string[] {
    return [...this.checkouts.keys(), ...this.strays.keys()];
  }

  private at(dir: string): Checkout {
    const checkout = this.checkouts.get(dir);

    if (checkout === undefined) throw new Error("not a repository");

    return checkout;
  }

  readonly fs = {
    readFile: notFound,
    readdir: (path: string) => {
      const names = this.strays.get(path);

      return names === undefined ? notFound() : Promise.resolve(names.map(dirent));
    },
    stat: (path: string) =>
      this.checkouts.has(path.replace(/\/\.git$/u, ""))
        ? Promise.resolve({ ...dirent(".git"), inode: 1, mode: 0o755, isDirectory: true })
        : notFound(),
    rm: (path: string) => {
      this.checkouts.delete(path);
      this.strays.delete(path);

      return Promise.resolve();
    },
    mkdir: () => Promise.resolve(),
    rename: (from: string, to: string) => {
      const moved = this.at(from);
      this.checkouts.delete(from);
      this.checkouts.set(to, moved);

      return Promise.resolve();
    },
  };

  readonly git = {
    clone: (options: { url: string; dir?: string; depth?: number }) => {
      const dir = options.dir ?? "";

      if (this.cloneHangs) {
        this.strays.set(dir, ["partial.pack"]);

        return new Promise<void>(() => {});
      }

      this.checkouts.set(dir, checkoutOf(options.url, options.depth ?? 1));

      return Promise.resolve();
    },
    configSet: (options: { dir?: string; path: string; value: unknown }) => {
      this.at(options.dir ?? "").config.set(options.path, options.value);

      return Promise.resolve();
    },
    configGet: (options: { dir?: string }) => Promise.resolve(this.at(options.dir ?? "").origin),
    show: (options: { dir?: string; ref: string }) =>
      this.at(options.dir ?? "").commits.has(options.ref)
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
    const checkout = this.checkouts.get(ROOT);
    const fetched = /origin ([0-9a-f]{40})/u.exec(source)?.[1];

    this.containerRuns += 1;

    if (checkout === undefined || this.containerOutput.exitCode !== 0) {
      return Effect.succeed(this.containerOutput);
    }

    if (fetched !== undefined) {
      checkout.commits.add(fetched);
      this.fetchedCommit = fetched;
    } else if (this.fetchedCommit !== undefined) {
      checkout.head = this.fetchedCommit;
    }

    return Effect.succeed(this.containerOutput);
  };
}

function provision(workspace: FakeHarnessWorkspace, commit: HarnessCommit) {
  return Effect.runPromise(
    provisionHarness(workspace, workspace.container, HARNESS_BUILD_CONFIGURATION, commit),
  );
}

const ok = { stdout: "", stderr: "", exitCode: 0 };

test("clones a missing harness at its root with file modes ignored, then advances it in the container", async () => {
  const workspace = new FakeHarnessWorkspace();

  await expect(provision(workspace, commitAt(3))).resolves.toEqual(ok);
  expect(workspace.paths(), "no staging tree is left beside the checkout").toEqual([ROOT]);
  expect(workspace.checkouts.get(ROOT)?.origin).toBe(REMOTE);
  expect(workspace.checkouts.get(ROOT)?.config.get("core.fileMode")).toBe(false);
  expect(workspace.containerRuns).toBe(1);
});

test("a clone cut off part way leaves the harness root free, so the next provision clones afresh", async () => {
  const workspace = new FakeHarnessWorkspace();
  workspace.cloneHangs = true;

  const cutOff = runInterruptible(
    provisionHarness(workspace, workspace.container, HARNESS_BUILD_CONFIGURATION, commitAt(3)),
  );

  await eventually(() => {
    expect(workspace.paths()).not.toEqual([]);
  });
  cutOff.interrupt();
  await expect(cutOff.interrupted).resolves.toBe(true);

  workspace.cloneHangs = false;

  await expect(provision(workspace, commitAt(3))).resolves.toEqual(ok);
  expect(workspace.paths()).toEqual([ROOT]);
  expect(workspace.checkouts.get(ROOT)?.origin).toBe(REMOTE);
});

test("refuses a populated directory that is not a repository and leaves it alone", async () => {
  const workspace = new FakeHarnessWorkspace();
  workspace.strays.set(ROOT, ["owned.txt"]);

  await expect(provision(workspace, commitAt(0))).resolves.toEqual({
    stdout: "",
    stderr: `${ROOT} is not a git repository and is not empty\n`,
    exitCode: 1,
  });
  expect(workspace.strays.get(ROOT)).toEqual(["owned.txt"]);
  expect(workspace.checkouts.size).toBe(0);
  expect(workspace.containerRuns).toBe(0);
});

test("refuses a checkout whose origin is another repository and leaves it alone", async () => {
  const workspace = new FakeHarnessWorkspace().cloned("https://github.com/someone/else.git");

  await expect(provision(workspace, commitAt(0))).resolves.toEqual({
    stdout: "",
    stderr: `${ROOT} has a different origin than ${REMOTE}\n`,
    exitCode: 1,
  });
  expect(workspace.checkouts.get(ROOT)?.origin).toBe("https://github.com/someone/else.git");
  expect(workspace.containerRuns).toBe(0);
});

test("fetches a commit the checkout lacks in the container, which brings the checkout to it", async () => {
  const workspace = new FakeHarnessWorkspace().cloned();
  const commit = commitAt(600);

  await expect(provision(workspace, commit)).resolves.toEqual(ok);
  expect(workspace.checkouts.get(ROOT)?.commits.has(commit)).toBe(true);
  expect(workspace.checkouts.get(ROOT)?.head).toBe(commit);
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
});
