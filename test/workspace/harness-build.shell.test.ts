import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { HARNESS_BUILD_CONFIGURATION, type HarnessBuildStepName } from "../../src/harness-build.js";
import {
  harnessBuildStep,
  planHarnessBuild,
  planHarnessBuildRequest,
} from "../../src/workspace/commands/build-harness.js";
import { testHarnessCommit } from "../harness-commit-fixtures.js";
import { writeExecutable } from "./planned-shell-fixture.js";
import {
  commitFile,
  git,
  makeRoot,
  originRepository,
  type Origin,
  rooted,
  runRooted,
  type Root,
} from "./rooted-shell.js";

let layout: Root;

let origin: Origin;

let head = testHarnessCommit("1".repeat(40));

beforeEach(() => {
  layout = makeRoot("cf-stumble-harness-shell-");
  origin = originRepository(layout);
  head = testHarnessCommit(git(origin.path, "rev-parse", "HEAD"));
});

afterEach(() => {
  rmSync(layout.root, { recursive: true, force: true });
});

const harness = (): string => join(layout.workspace, "harness");

const buildDirectory = (commit: string): string => join(layout.tmp, "cf-stumble-builds", commit);

function runStep(name: HarnessBuildStepName, commit = head, remote = origin.url) {
  const plan = planHarnessBuild(HARNESS_BUILD_CONFIGURATION, commit);
  const source = rooted(harnessBuildStep(plan, name).source, layout);

  return runRooted(layout, source.replaceAll(HARNESS_BUILD_CONFIGURATION.harnessGitRemote, remote));
}

function runOk(name: HarnessBuildStepName, commit = head): void {
  const ran = runStep(name, commit);

  expect(ran.status, ran.stderr).toBe(0);
}

function keep(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "precious");

  return path;
}

describe("the isolate step", () => {
  test("clears its own scratch directory and nothing else", () => {
    const stale = keep(join(buildDirectory(head), "stale.txt"));

    const survivors = [
      keep(join(harness(), "edited.txt")),
      keep(join(layout.workspace, "projects", "one", "edited.txt")),
      keep(join(buildDirectory("2".repeat(40)), "other-build.txt")),
    ];

    runOk("isolate");

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(buildDirectory(head))).toBe(true);
    expect(survivors.filter((path) => !existsSync(path))).toEqual([]);
  });
});

describe("the discard request", () => {
  test("removes its own scratch tree, dependencies included, and nothing else", () => {
    const built = [
      keep(join(buildDirectory(head), "node_modules", ".pnpm", "dependency.js")),
      keep(join(buildDirectory(head), "build", "module-map.json")),
    ];

    const survivors = [
      keep(join(harness(), "edited.txt")),
      keep(join(layout.workspace, "projects", "one", "edited.txt")),
      keep(join(buildDirectory("2".repeat(40)), "other-build.txt")),
    ];

    const plan = planHarnessBuildRequest(HARNESS_BUILD_CONFIGURATION, {
      kind: "build-discard",
      harnessCommit: head,
    });

    const ran = runRooted(layout, rooted(plan.source, layout));

    expect(ran.status, ran.stderr).toBe(0);
    expect(built.filter((path) => existsSync(path))).toEqual([]);
    expect(existsSync(buildDirectory(head))).toBe(false);
    expect(survivors.filter((path) => !existsSync(path))).toEqual([]);
  });
});

describe("a build phase", () => {
  beforeEach(() => {
    writeExecutable(
      join(layout.bin, "pnpm"),
      `#!/bin/sh\npwd > "${layout.root}/phase-directory"\n`,
    );
  });

  test.each(HARNESS_BUILD_CONFIGURATION.buildPhases.map((phase) => phase.name))(
    "%s runs inside its own scratch directory, whatever directory the step starts in",
    (name) => {
      runOk("isolate");
      runOk(name);

      expect(readFileSync(join(layout.root, "phase-directory"), "utf8").trim()).toBe(
        buildDirectory(head),
      );
    },
  );
});

describe("the checkout step", () => {
  test("unpacks the commit into the build directory and leaves no archive behind", () => {
    runOk("provision");
    runOk("isolate");
    runOk("checkout");

    expect(readdirSync(buildDirectory(head))).toEqual(["first.txt"]);
  });

  test("fails on its own when the archive cannot be made", () => {
    runOk("provision");
    const missing = testHarnessCommit("5".repeat(40));
    runOk("isolate", missing);

    const ran = runStep("checkout", missing);

    expect(ran.status).not.toBe(0);
  });
});

describe("the provision step", () => {
  test("clones the harness and has the requested commit", () => {
    runOk("provision");

    expect(git(harness(), "cat-file", "-t", head)).toBe("commit");
    expect(git(harness(), "config", "--get", "remote.origin.url")).toBe(origin.url);
  });

  test("fetches a commit pushed after a checkout that holds no promisor remote was made", () => {
    git(layout.workspace, "clone", "-q", origin.url, "harness");
    const pushed = testHarnessCommit(commitFile(origin.path, "second.txt", "second"));

    runOk("provision", pushed);

    expect(git(harness(), "cat-file", "-t", pushed)).toBe("commit");
  });

  test("fails, naming the commit and the remote, when the remote does not have the commit", () => {
    const absent = testHarnessCommit("7".repeat(40));

    const ran = runStep("provision", absent);

    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain(absent);
    expect(ran.stderr).toContain(origin.url);
  });

  test("leaves an existing checkout's history, working tree and configuration as they were", () => {
    runOk("provision");
    git(harness(), "config", "core.fileMode", "true");
    const local = commitFile(harness(), "local.txt", "local");
    const untracked = keep(join(harness(), "scratch.txt"));

    runOk("provision");

    expect(git(harness(), "rev-parse", "HEAD")).toBe(local);
    expect(existsSync(untracked)).toBe(true);
    expect(git(harness(), "config", "core.fileMode")).toBe("true");
  });

  test("refuses a populated directory that is not a repository and leaves it alone", () => {
    const owned = keep(join(harness(), "owned.txt"));

    const ran = runStep("provision");

    expect(ran.status).toBe(1);
    expect(readFileSync(owned, "utf8")).toBe("precious");
    expect(readdirSync(harness())).toEqual(["owned.txt"]);
  });

  test("refuses an existing checkout whose origin is another repository and leaves it alone", () => {
    runOk("provision");
    const local = commitFile(harness(), "local.txt", "local");

    const ran = runStep("provision", head, `file://${layout.root}/another-origin`);

    expect(ran.status).toBe(1);
    expect(git(harness(), "rev-parse", "HEAD")).toBe(local);
    expect(git(harness(), "config", "--get", "remote.origin.url")).toBe(origin.url);
  });

  test("leaves no checkout and no staging tree when the clone fails", () => {
    const ran = runStep("provision", head, `file://${layout.root}/no-such-remote`);

    expect(ran.status).not.toBe(0);
    expect(readdirSync(layout.workspace)).toEqual([]);
  });
});
