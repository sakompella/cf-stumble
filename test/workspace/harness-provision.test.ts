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

const HOST_GIT_READ = "Git objects are read in the container, not on the Workspace Host";

const REMOTE = HARNESS_BUILD_CONFIGURATION.harnessGitRemote;

const COMMIT = testHarnessCommit("a".repeat(40));

type Checkout = {
  origin: string;
  config: Map<string, unknown>;
};

function checkoutOf(origin: string): Checkout {
  return { origin, config: new Map() };
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
  cloneHangs = false;
  containerOutput: CommandOutput = { stdout: "", stderr: "", exitCode: 0 };

  cloned(origin: string = REMOTE): this {
    this.checkouts.set(ROOT, checkoutOf(origin));

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

      this.checkouts.set(dir, checkoutOf(options.url));

      return Promise.resolve();
    },
    configSet: (options: { dir?: string; path: string; value: unknown }) => {
      this.at(options.dir ?? "").config.set(options.path, options.value);

      return Promise.resolve();
    },
    configGet: (): Promise<never> => Promise.reject(new Error(HOST_GIT_READ)),
    show: (): Promise<never> => Promise.reject(new Error(HOST_GIT_READ)),
  };

  readonly container = (_source: string) => {
    this.containerRuns += 1;

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

  await expect(provision(workspace, COMMIT)).resolves.toEqual(ok);
  expect(workspace.paths(), "no staging tree is left beside the checkout").toEqual([ROOT]);
  expect(workspace.checkouts.get(ROOT)?.origin).toBe(REMOTE);
  expect(workspace.checkouts.get(ROOT)?.config.get("core.fileMode")).toBe(false);
  expect(workspace.containerRuns).toBe(1);
});

test("a clone cut off part way leaves the harness root free, so the next provision clones afresh", async () => {
  const workspace = new FakeHarnessWorkspace();
  workspace.cloneHangs = true;

  const cutOff = runInterruptible(
    provisionHarness(workspace, workspace.container, HARNESS_BUILD_CONFIGURATION, COMMIT),
  );

  await eventually(() => {
    expect(workspace.paths()).not.toEqual([]);
  });
  cutOff.interrupt();
  await expect(cutOff.interrupted).resolves.toBe(true);

  workspace.cloneHangs = false;

  await expect(provision(workspace, COMMIT)).resolves.toEqual(ok);
  expect(workspace.paths()).toEqual([ROOT]);
  expect(workspace.checkouts.get(ROOT)?.origin).toBe(REMOTE);
});

test("refuses a populated directory that is not a repository and leaves it alone", async () => {
  const workspace = new FakeHarnessWorkspace();
  workspace.strays.set(ROOT, ["owned.txt"]);

  await expect(provision(workspace, COMMIT)).resolves.toEqual({
    stdout: "",
    stderr: `${ROOT} is not a git repository and is not empty\n`,
    exitCode: 1,
  });
  expect(workspace.strays.get(ROOT)).toEqual(["owned.txt"]);
  expect(workspace.checkouts.size).toBe(0);
  expect(workspace.containerRuns).toBe(0);
});

test("provisioning an existing checkout reads no Git objects on the Workspace Host", async () => {
  const workspace = new FakeHarnessWorkspace().cloned();

  await expect(provision(workspace, COMMIT)).resolves.toEqual(ok);
  expect(workspace.containerRuns).toBe(1);
});

test("a failing container script fails the provision with its exit code and message", async () => {
  const workspace = new FakeHarnessWorkspace().cloned();
  workspace.containerOutput = { stdout: "", stderr: "fatal: not a repository\n", exitCode: 128 };

  await expect(provision(workspace, COMMIT)).resolves.toEqual({
    stdout: "",
    stderr: "fatal: not a repository\n",
    exitCode: 128,
  });
});

test("reports what the container's advance of the checkout says", async () => {
  const workspace = new FakeHarnessWorkspace().cloned();
  const message = `harness checkout has local changes; left at ${COMMIT.slice(0, 7)}\n`;
  workspace.containerOutput = { stdout: "", stderr: message, exitCode: 0 };

  await expect(provision(workspace, COMMIT)).resolves.toEqual({
    stdout: "",
    stderr: message,
    exitCode: 0,
  });
});
