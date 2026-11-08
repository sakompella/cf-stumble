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

function cloneHarness(): void {
  git(layout.workspace, "clone", "-q", origin.url, "harness");
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
    cloneHarness();
    runOk("isolate");
    runOk("checkout");

    expect(readdirSync(buildDirectory(head))).toEqual(["first.txt"]);
  });

  test("fails on its own when the archive cannot be made", () => {
    cloneHarness();
    const missing = testHarnessCommit("5".repeat(40));
    runOk("isolate", missing);

    const ran = runStep("checkout", missing);

    expect(ran.status).not.toBe(0);
  });
});
