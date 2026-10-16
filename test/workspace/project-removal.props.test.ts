import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  planProjectProvision,
  projectProvisionLockPath,
  projectProvisionStep,
} from "../../src/project-provision.js";
import { planProjectRemovalRequest } from "../../src/workspace/project-removal.js";
import { projectDirectory } from "../../src/workspace-layout.js";
import { sampleProjectOne } from "../project-fixtures.js";
import {
  FLOCK_STAND_IN,
  STUB_GIT,
  scratchDirectory,
  underScratch,
  writeExecutable,
} from "./planned-shell-fixture.js";

/**
 * The planned removal and clone commands run under `/bin/sh` on the host, with stand-ins for
 * `git`, `flock`, and the removal's `rm`. The Workspace Host runs them in Computer under Debian's
 * `dash` with util-linux `flock`, so these tests show how the two scripts share the lock on this
 * host, not in the container.
 *
 * The `rm` stand-in deletes from a background child that inherits the shell's descriptors and
 * waits for a release marker, the way a real `rm` or `git clone` can outlive a shell that was
 * killed. Tests wait for markers, not for a fixed time, except to show that a clone has not
 * started, which no marker can show.
 */

const scratch = scratchDirectory("cf-stumble-removal-lock-");

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const HELD_REMOVAL_RM = `#!/bin/sh
if [ "$2" = "--" ] && [ -n "$STUB_HOLD_RM" ]; then
  (
    : > "$STUB_DIR/rm-started"
    while [ ! -e "$STUB_DIR/rm-release" ]; do /bin/sleep 0.05; done
    /bin/rm "$@"
  ) &
  wait
  exit 0
fi
exec /bin/rm "$@"
`;

let runCount = 0;

type Run = Readonly<{ root: string; bin: string; project: string; lock: string }>;

function prepare(): Run {
  runCount += 1;
  const root = join(scratch, String(runCount));
  const bin = join(root, "bin");
  const project = join(root, projectDirectory(sampleProjectOne.id).slice(1));
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(root, "tmp"));
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "uncommitted.txt"), "work");
  writeExecutable(join(bin, "git"), STUB_GIT);
  writeExecutable(join(bin, "rm"), HELD_REMOVAL_RM);
  writeExecutable(join(bin, "flock"), FLOCK_STAND_IN);
  // The host may scan a new executable on its first run; do that before any timing matters.
  execFileSync(join(bin, "rm"), ["-f", join(root, "absent")]);
  execFileSync(join(bin, "git"), ["--version"]);

  return {
    root,
    bin,
    project,
    lock: join(root, projectProvisionLockPath(sampleProjectOne.id).slice(1)),
  };
}

function start(run: Run, source: string, holdRemoval = false): ChildProcess {
  return spawn("/bin/sh", ["-c", underScratch(source, run.root)], {
    env: {
      PATH: `${run.bin}:/usr/bin:/bin`,
      STUB_DIR: run.root,
      STUB_REMOTE: sampleProjectOne.repositoryUrl,
      STUB_HOLD_RM: holdRemoval ? "1" : "",
    },
    stdio: "ignore",
  });
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    child.on("exit", (code) => {
      resolve(code);
    });
  });
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function untilExists(path: string): Promise<void> {
  for (let attempt = 0; attempt < 250 && !existsSync(path); attempt += 1) await pause(20);

  expect(existsSync(path), `${path} appeared`).toBe(true);
}

function removalSource(): string {
  return planProjectRemovalRequest({ kind: "remove-project", projectId: sampleProjectOne.id })
    .source;
}

function cloneSource(): string {
  const step = projectProvisionStep(planProjectProvision(sampleProjectOne), "clone");

  return step.source;
}

test("a removal waits while another process holds the project's lock", async () => {
  const run = prepare();
  const held = join(run.root, "held");
  const released = join(run.root, "holder-release");

  const holder = start(
    run,
    [
      `lock='${run.lock}'`,
      'exec 9>"$lock"',
      "flock 9",
      `: > '${held}'`,
      `while [ ! -e '${released}' ]; do /bin/sleep 0.05; done`,
    ].join("\n"),
  );

  await untilExists(held);
  const removed = exited(start(run, removalSource()));
  await pause(500);

  expect(existsSync(join(run.project, "uncommitted.txt")), "the clone is still there").toBe(true);

  writeFileSync(released, "");

  await expect(exited(holder)).resolves.toBe(0);
  await expect(removed).resolves.toBe(0);
  expect(existsSync(run.project)).toBe(false);
}, 20_000);

test("a clone that starts during a removal waits and survives it", async () => {
  const run = prepare();
  const removed = exited(start(run, removalSource(), true));
  await untilExists(join(run.root, "rm-started"));

  const cloned = exited(start(run, cloneSource()));
  await pause(500);

  expect(existsSync(join(run.root, "git.log")), "no clone starts while the removal runs").toBe(
    false,
  );

  writeFileSync(join(run.root, "rm-release"), "");

  await expect(removed).resolves.toBe(0);
  await expect(cloned).resolves.toBe(0);
  expect(existsSync(join(run.project, ".git")), "the new clone is not removed").toBe(true);
}, 20_000);

test("a clone waits for a removal whose shell was killed while its rm still runs", async () => {
  const run = prepare();
  const removal = start(run, removalSource(), true);
  const removalExited = exited(removal);
  await untilExists(join(run.root, "rm-started"));

  removal.kill("SIGKILL");
  await removalExited;

  const cloned = exited(start(run, cloneSource()));
  await pause(500);

  expect(
    existsSync(join(run.root, "git.log")),
    "the surviving rm still holds the lock, so no clone starts",
  ).toBe(false);

  writeFileSync(join(run.root, "rm-release"), "");

  await expect(cloned).resolves.toBe(0);
  expect(existsSync(join(run.project, ".git")), "the new clone is not removed").toBe(true);
  expect(existsSync(join(run.project, "uncommitted.txt"))).toBe(false);
}, 20_000);
