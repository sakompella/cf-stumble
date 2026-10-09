import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, expect, test } from "vitest";
import { HARNESS_BUILD_CONFIGURATION, provisionHarnessRepository } from "../src/harness-build.js";
import { testHarnessCommit } from "./harness-commit-fixtures.js";
import {
  FLOCK_STAND_IN,
  STUB_GIT,
  scratchDirectory,
  underScratch,
  writeExecutable,
} from "./workspace/planned-shell-fixture.js";

/**
 * The planned harness provision step runs under `/bin/sh` on the host, with stand-ins for `git`
 * and `flock`. With `STUB_HOLD_CLONE` the `git clone` stand-in writes its target and then waits for
 * a release marker, so the test can kill the shell while the clone still runs, the way a timed-out
 * step's shell dies and its `git clone` outlives it. The Workspace Host runs the step in Computer
 * under Debian's `dash`, so these tests show what the planned text does on this host, not in the
 * container.
 */

const scratch = scratchDirectory("cf-stumble-harness-staging-");

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const HELD_CLONE_GIT = `#!/bin/sh
case "$1" in
  clone)
    if [ -n "$STUB_HOLD_CLONE" ]; then
      for target; do :; done
      mkdir -p "$target/.git"
      : > "$STUB_DIR/clone-started"
      while [ ! -e "$STUB_DIR/clone-release" ] && [ -d "$STUB_DIR" ]; do /bin/sleep 0.05; done
      exit 0
    fi
    ;;
esac
exec "$STUB_DIR/bin/stub-git" "$@"
`;

let runCount = 0;

function prepare(): string {
  runCount += 1;
  const root = join(scratch, String(runCount));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(root, "tmp"));
  writeExecutable(join(bin, "git"), HELD_CLONE_GIT);
  writeExecutable(join(bin, "stub-git"), STUB_GIT);
  writeExecutable(join(bin, "flock"), FLOCK_STAND_IN);

  return root;
}

function provisionSource(root: string): string {
  const source = provisionHarnessRepository(
    HARNESS_BUILD_CONFIGURATION,
    testHarnessCommit("7000000000000000000000000000000000000001"),
  );

  return underScratch(source.replaceAll("'/workspace'", `'${root}/workspace'`), root);
}

function environment(root: string, holdClone: boolean): NodeJS.ProcessEnv {
  return {
    PATH: `${join(root, "bin")}:/usr/bin:/bin`,
    STUB_DIR: root,
    STUB_REMOTE: HARNESS_BUILD_CONFIGURATION.harnessGitRemote,
    STUB_HOLD_CLONE: holdClone ? "1" : "",
  };
}

async function untilExists(path: string): Promise<void> {
  for (let attempt = 0; attempt < 250 && !existsSync(path); attempt += 1) await delay(20);

  expect(existsSync(path), `${path} appeared`).toBe(true);
}

/** Start a provision, kill its shell while the clone runs, then let the orphaned clone finish. */
async function killProvisionDuringClone(root: string): Promise<void> {
  const killed = spawn("/bin/sh", ["-c", provisionSource(root)], {
    env: environment(root, true),
    stdio: "ignore",
  });

  const exited = new Promise((resolve) => {
    killed.once("exit", resolve);
  });

  await untilExists(join(root, "clone-started"));
  killed.kill("SIGKILL");
  await exited;
  writeFileSync(join(root, "clone-release"), "");
}

function provision(root: string): void {
  const ran = spawnSync("/bin/sh", ["-c", provisionSource(root)], {
    encoding: "utf8",
    env: environment(root, false),
  });

  expect(ran.status, ran.stderr).toBe(0);
}

test("the next provision clears the staging tree a killed provision left", async () => {
  const root = prepare();

  await killProvisionDuringClone(root);
  provision(root);

  expect(readdirSync(join(root, "workspace"))).toEqual(["harness"]);
}, 20_000);

test("a provision that finds the checkout in place still clears a killed provision's staging tree", async () => {
  const root = prepare();

  await killProvisionDuringClone(root);
  mkdirSync(join(root, "workspace", "harness", ".git"), { recursive: true });
  writeFileSync(join(root, "existing-clone"), "");
  provision(root);

  expect(readdirSync(join(root, "workspace"))).toEqual(["harness"]);
}, 20_000);
