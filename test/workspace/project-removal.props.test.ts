import { devShellTool } from "../dev-shell-tool.js";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  projectCloneSource,
  projectProvisionLockPath,
} from "../../src/workspace/commands/provision-project.js";
import { planProjectRemovalRequest } from "../../src/workspace/commands/remove-project.js";
import { projectDirectory } from "../../src/workspace-layout.js";
import { sampleProjectOne } from "../project-fixtures.js";
import {
  FLOCK_STAND_IN,
  STUB_GIT,
  scratchDirectory,
  systemToolsDirectory,
  underScratch,
  writeExecutable,
} from "./planned-shell-fixture.js";

const scratch = scratchDirectory("cf-stumble-removal-lock-");

const systemTools = systemToolsDirectory(scratch);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const HELD_REMOVAL_RM = `#!/bin/sh
if [ "$2" = "--" ] && [ -n "$STUB_HOLD_RM" ]; then
  (
    : > "$STUB_DIR/rm-started"
    while [ ! -e "$STUB_DIR/rm-release" ]; do sleep 0.05; done
    PATH="\${PATH#*:}"
    rm "$@"
  ) &
  wait
  exit 0
fi
PATH="\${PATH#*:}"
exec rm "$@"
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
  execFileSync(join(bin, "rm"), ["-f", join(root, "absent")]);
  execFileSync(join(bin, "git"), ["--version"]);

  return {
    root,
    bin,
    project,
    lock: join(root, projectProvisionLockPath(sampleProjectOne.id).slice(1)),
  };
}

type StartOptions = Readonly<{ holdRemoval?: boolean; flockMark?: string }>;

function start(run: Run, source: string, options: StartOptions = {}): ChildProcess {
  return spawn(devShellTool("sh"), ["-c", underScratch(source, run.root)], {
    env: {
      PATH: `${run.bin}:${systemTools}`,
      STUB_DIR: run.root,
      STUB_REMOTE: sampleProjectOne.repositoryUrl,
      STUB_HOLD_RM: options.holdRemoval === true ? "1" : "",
      STUB_FLOCK_MARK: options.flockMark ?? "",
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

test("a removal waits while another process holds the project's lock", async () => {
  const run = prepare();
  const held = join(run.root, "held");
  const released = join(run.root, "holder-release");
  const exits: Promise<number | null>[] = [];

  try {
    const holder = start(
      run,
      [
        `lock='${run.lock}'`,
        'exec 9>"$lock"',
        "flock 9",
        `: > '${held}'`,
        `while [ ! -e '${released}' ]; do sleep 0.05; done`,
      ].join("\n"),
    );

    const holderExit = exited(holder);
    exits.push(holderExit);
    await untilExists(held);

    const reachedLock = join(run.root, "removal-reached-lock");
    const removed = exited(start(run, removalSource(), { flockMark: reachedLock }));
    exits.push(removed);
    await untilExists(reachedLock);

    expect(existsSync(join(run.project, "uncommitted.txt")), "the clone is still there").toBe(true);

    writeFileSync(released, "");

    await expect(holderExit).resolves.toBe(0);
    await expect(removed).resolves.toBe(0);
    expect(existsSync(run.project)).toBe(false);
  } finally {
    writeFileSync(released, "");
    await Promise.allSettled(exits);
  }
}, 20_000);

test("a clone that starts during a removal waits and survives it", async () => {
  const run = prepare();
  const rmRelease = join(run.root, "rm-release");
  const exits: Promise<number | null>[] = [];

  try {
    const removed = exited(start(run, removalSource(), { holdRemoval: true }));
    exits.push(removed);
    await untilExists(join(run.root, "rm-started"));

    const reachedLock = join(run.root, "clone-reached-lock");

    const cloned = exited(
      start(run, projectCloneSource(sampleProjectOne), { flockMark: reachedLock }),
    );

    exits.push(cloned);
    await untilExists(reachedLock);

    expect(existsSync(join(run.root, "git.log")), "no clone starts while the removal runs").toBe(
      false,
    );

    writeFileSync(rmRelease, "");

    await expect(removed).resolves.toBe(0);
    await expect(cloned).resolves.toBe(0);
    expect(existsSync(join(run.project, ".git")), "the new clone is not removed").toBe(true);
  } finally {
    writeFileSync(rmRelease, "");
    await Promise.allSettled(exits);
  }
}, 20_000);

test("a clone waits for a removal whose shell was killed while its rm still runs", async () => {
  const run = prepare();
  const rmRelease = join(run.root, "rm-release");
  const exits: Promise<number | null>[] = [];

  try {
    const removal = start(run, removalSource(), { holdRemoval: true });
    const removalExit = exited(removal);
    exits.push(removalExit);
    await untilExists(join(run.root, "rm-started"));

    removal.kill("SIGKILL");
    await removalExit;

    const reachedLock = join(run.root, "clone-reached-lock");

    const cloned = exited(
      start(run, projectCloneSource(sampleProjectOne), { flockMark: reachedLock }),
    );

    exits.push(cloned);
    await untilExists(reachedLock);

    expect(
      existsSync(join(run.root, "git.log")),
      "the surviving rm still holds the lock, so no clone starts",
    ).toBe(false);

    writeFileSync(rmRelease, "");

    await expect(cloned).resolves.toBe(0);
    expect(existsSync(join(run.project, ".git")), "the new clone is not removed").toBe(true);
    expect(existsSync(join(run.project, "uncommitted.txt"))).toBe(false);
  } finally {
    writeFileSync(rmRelease, "");
    await Promise.allSettled(exits);
  }
}, 20_000);
