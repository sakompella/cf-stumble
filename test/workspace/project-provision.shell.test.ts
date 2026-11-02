import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  PROJECT_CLONE_SIZE_FAILURE_EXIT_CODE,
  projectCloneSource,
  projectProvisionLockPath,
} from "../../src/project-provision.js";
import { sampleProjectOne } from "../project-fixtures.js";
import { writeExecutable } from "./planned-shell-fixture.js";
import {
  commitFile,
  git,
  makeRoot,
  originRepository,
  rooted,
  runRooted,
  type Origin,
  type Root,
} from "./rooted-shell.js";

let layout: Root;

let origin: Origin;

beforeEach(() => {
  layout = makeRoot("cf-stumble-project-shell-");
  origin = originRepository(layout);
});

afterEach(() => {
  rmSync(layout.root, { recursive: true, force: true });
});

const project = sampleProjectOne;

const checkout = (): string => join(layout.workspace, "projects", project.id);

function provision() {
  const source = rooted(projectCloneSource(project), layout);

  return runRooted(layout, source.replaceAll(project.repositoryUrl, origin.url));
}

function keep(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "precious");

  return path;
}

describe("provisioning a project clone", () => {
  test("a fresh clone becomes the project's directory, and no staging tree is left", () => {
    const ran = provision();

    expect(ran.status, ran.stderr).toBe(0);
    expect(readFileSync(join(checkout(), "first.txt"), "utf8")).toBe("first");
    expect(git(checkout(), "config", "core.fileMode")).toBe("false");
    expect(readdirSync(join(layout.workspace, "projects"))).toEqual([project.id]);
  });

  test("an existing clone keeps its commits, working tree and configuration", () => {
    expect(provision().status).toBe(0);
    git(checkout(), "config", "core.fileMode", "true");
    const local = commitFile(checkout(), "local.txt", "local");
    const untracked = keep(join(checkout(), "scratch.txt"));

    const ran = provision();

    expect(ran.status, ran.stderr).toBe(0);
    expect(git(checkout(), "rev-parse", "HEAD")).toBe(local);
    expect(existsSync(untracked)).toBe(true);
    expect(git(checkout(), "config", "core.fileMode")).toBe("true");
  });

  test("a populated directory that is not a repository is refused and left alone", () => {
    const owned = keep(join(checkout(), "owned.txt"));

    const ran = provision();

    expect(ran.status).toBe(1);
    expect(readFileSync(owned, "utf8")).toBe("precious");
    expect(readdirSync(checkout())).toEqual(["owned.txt"]);
  });

  test("the lock file survives a provision, so two holders can never lock different files", () => {
    expect(provision().status).toBe(0);

    expect(existsSync(rooted(projectProvisionLockPath(project.id), layout))).toBe(true);
  });
});

function cloneFailing(message: string) {
  const source = rooted(projectCloneSource(project), layout);

  return runRooted(layout, source, { STUB_CLONE_MESSAGE: message });
}

describe("when the clone command fails", () => {
  beforeEach(() => {
    writeExecutable(
      join(layout.bin, "git"),
      `#!/bin/sh
case "$1" in
  clone) printf '%s\\n' "$STUB_CLONE_MESSAGE" >&2; exit 128 ;;
esac
exit 128
`,
    );
  });

  test.each(["error: No space left on device", "fatal: write error: Disk quota exceeded"])(
    "%s is reported as a repository size failure and leaves no directory behind",
    (message) => {
      const ran = cloneFailing(message);

      expect(ran.status).toBe(PROJECT_CLONE_SIZE_FAILURE_EXIT_CODE);
      expect(readdirSync(join(layout.workspace, "projects"))).toEqual([]);
    },
  );

  test("any other clone failure keeps git's own exit status and message", () => {
    const ran = cloneFailing("fatal: repository not found");

    expect(ran.status).toBe(128);
    expect(ran.stderr).toContain("repository not found");
  });
});
