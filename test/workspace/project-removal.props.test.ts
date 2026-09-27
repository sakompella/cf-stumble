import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  planProjectProvision,
  projectProvisionConfiguration,
  projectProvisionStep,
} from "../../src/project-provision.js";
import { planProjectRemovalRequest } from "../../src/workspace/project-removal.js";
import { projectDirectory } from "../../src/workspace-layout.js";
import { sampleProjectOne } from "../project-fixtures.js";
import {
  STUB_GIT,
  scratchDirectory,
  underScratch,
  writeExecutable,
} from "./planned-shell-fixture.js";

/**
 * The planned removal and clone commands run under `/bin/sh` on the host, with stub `git` and, where
 * a test needs time to act, a slow `rm` for the removal. The Workspace Host runs them in Computer, whose `/workspace` is a
 * computerd mount, so these tests show how the two scripts share the provision lock on an
 * ordinary filesystem, not how that mount orders the same operations.
 */

const scratch = scratchDirectory("cf-stumble-removal-lock-");

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Slows only the removal's own `rm -rf -- ...`, so a test can act while it is running. */
const SLOW_REMOVAL_RM = `#!/bin/sh
if [ "$2" = "--" ] && [ -n "\${STUB_SLOW_RM:-}" ]; then sleep 2; fi
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
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "uncommitted.txt"), "work");
  writeExecutable(join(bin, "git"), STUB_GIT);
  writeExecutable(join(bin, "rm"), SLOW_REMOVAL_RM);
  // The host may scan a new executable on its first run; do that before any timing matters.
  execFileSync(join(bin, "rm"), ["-f", join(root, "absent")]);
  execFileSync(join(bin, "git"), ["--version"]);

  return { root, bin, project, lock: `${project}.provision-lock` };
}

function start(run: Run, source: string, slowRemoval = false): ChildProcess {
  return spawn("/bin/sh", ["-c", underScratch(source, run.root)], {
    env: {
      PATH: `${run.bin}:/usr/bin:/bin`,
      STUB_DIR: run.root,
      STUB_REMOTE: sampleProjectOne.repositoryUrl,
      STUB_SLOW_RM: slowRemoval ? "1" : "",
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
  for (let attempt = 0; attempt < 100 && !existsSync(path); attempt += 1) await pause(20);
}

function removalSource(): string {
  return planProjectRemovalRequest({ kind: "remove-project", projectId: sampleProjectOne.id })
    .source;
}

function cloneSource(): string {
  const step = projectProvisionStep(
    planProjectProvision(projectProvisionConfiguration(sampleProjectOne.id), sampleProjectOne),
    "clone",
  );

  if (step.name !== "clone") throw new Error("the clone step must be the command step");

  return step.source;
}

test("a removal waits for a live provision lock and does not delete it", async () => {
  const run = prepare();
  const holder = spawn("/bin/sh", ["-c", "sleep 30"], { stdio: "ignore" });
  mkdirSync(run.lock);
  writeFileSync(join(run.lock, "pid"), `${String(holder.pid)}\n`);

  const removal = start(run, removalSource());
  const removed = exited(removal);
  await pause(500);

  expect(existsSync(join(run.project, "uncommitted.txt")), "the clone is still there").toBe(true);
  expect(readFileSync(join(run.lock, "pid"), "utf8").trim()).toBe(String(holder.pid));

  holder.kill();

  await expect(removed).resolves.toBe(0);
  expect(existsSync(run.project)).toBe(false);
  expect(existsSync(run.lock), "the removal releases the lock it took").toBe(false);
}, 20_000);

test("a clone that starts during a removal waits and survives it", async () => {
  const run = prepare();
  const removal = start(run, removalSource(), true);
  const removed = exited(removal);
  await untilExists(join(run.lock, "pid"));

  const clone = start(run, cloneSource());
  const cloned = exited(clone);
  await pause(500);

  expect(existsSync(join(run.root, "git.log")), "no clone starts while the removal runs").toBe(
    false,
  );

  await expect(removed).resolves.toBe(0);
  await expect(cloned).resolves.toBe(0);
  expect(existsSync(join(run.project, ".git")), "the new clone is not removed").toBe(true);
}, 20_000);
