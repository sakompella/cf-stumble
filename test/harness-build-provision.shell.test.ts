import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { holdProvisionLock } from "../src/harness-build-provision.js";
import { shellQuote } from "../src/shell-quote.js";

/**
 * These tests run the provision lock's real shell text in several real shell processes at once.
 * Each process stops at a chosen point, so every run sees the same interleaving.
 *
 * A stand-in for `flock` comes first on each process's `PATH`. It takes the kernel lock on the
 * same descriptor with the real `flock` when the machine has one, and with Perl's `flock` when it
 * does not (macOS ships no `flock` command). It first tries without waiting. When that fails it
 * records that the lock was held, then waits, so a test can tell "waiting" from "entered" without
 * a timing guess. With `PAUSE_AFTER_ACQUIRE` it pauses after taking the lock, which is the moment
 * the earlier directory lock existed without an owner.
 *
 * The section the lock guards records `enter` and `leave` and stays inside until the test
 * releases it. With `KEEP_CHILD` it first starts a background child that keeps running after its
 * shell is killed, the way a `git clone` outlives a step whose direct shell was signalled.
 *
 * These tests do not show how the workspace container behaves: it runs the step under Debian's
 * `dash` with util-linux `flock`, and neither may be present here.
 */

const shells = ["/bin/sh", "/bin/dash"].filter((shell) => existsSync(shell));

const realSleep = ["/bin/sleep", "/usr/bin/sleep"].find((path) => existsSync(path)) ?? "sleep";

const flockStandIn = `#!/bin/sh
set -eu
if [ "$#" -ne 1 ]; then
  printf "the flock stand-in takes one descriptor, not: %s\\n" "$*" >&2
  exit 2
fi
descriptor="$1"
real="$(PATH="$REAL_PATH" command -v flock || true)"
take() {
  if [ -n "$real" ]; then
    "$real" "$1" "$descriptor"
  else
    perl -MFcntl=:flock -e '
      open(my $held, ">&=", $ARGV[1]) or die "flock stand-in: $!\\n";
      flock($held, LOCK_EX | ($ARGV[0] eq "-n" ? LOCK_NB : 0)) or exit 1;
    ' -- "$1" "$descriptor"
  fi
}
if ! take -n; then
  : > "$BLOCKED_MARK"
  take -x
fi
if [ -n "$PAUSE_AFTER_ACQUIRE" ]; then
  eval "exec $descriptor>&-"
  : > "$PAUSE_AFTER_ACQUIRE/paused"
  while [ ! -e "$PAUSE_AFTER_ACQUIRE/resume" ] && [ -d "$PAUSE_AFTER_ACQUIRE" ]; do "$REAL_SLEEP" 0.01; done
fi
`;

const guardedSection = [
  'if [ -n "$KEEP_CHILD" ]; then',
  '  (while [ ! -e "$KEEP_CHILD" ] && [ -d "$OWN" ]; do "$REAL_SLEEP" 0.01; done) &',
  "fi",
  'printf "enter %s\\n" "$NAME" >> "$EVENTS"',
  'while [ ! -e "$RELEASE" ] && [ -d "$OWN" ]; do "$REAL_SLEEP" 0.01; done',
  'printf "leave %s\\n" "$NAME" >> "$EVENTS"',
];

type Exit = Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;

type Options = Readonly<{ pauseAfterAcquire?: boolean; keepChild?: boolean }>;

type Contender = Readonly<{
  hasPaused: () => boolean;
  hasBlocked: () => boolean;
  hasEntered: () => boolean;
  resume: () => void;
  release: () => void;
  releaseChild: () => void;
  kill: () => void;
  exited: Promise<Exit>;
}>;

let root = "";

let lock = "";

let eventsPath = "";

let standIns = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "provision-lock-"));
  lock = join(root, "harness-provision.lock");
  eventsPath = join(root, "events");
  standIns = join(root, "bin");

  mkdirSync(standIns);
  writeFileSync(join(standIns, "flock"), flockStandIn);
  chmodSync(join(standIns, "flock"), 0o755);
  writeFileSync(eventsPath, "");
});

afterEach(() => {
  // Every paused or waiting loop above also stops once its directory is gone.
  rmSync(root, { recursive: true, force: true });
});

function events(): readonly string[] {
  return readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

function start(shell: string, name: string, options: Options = {}): Contender {
  const own = join(root, name);
  const marker = (file: string): string => join(own, file);

  const settings = {
    REAL_SLEEP: realSleep,
    OWN: own,
    NAME: name,
    EVENTS: eventsPath,
    RELEASE: marker("release"),
    BLOCKED_MARK: marker("blocked"),
    PAUSE_AFTER_ACQUIRE: options.pauseAfterAcquire === true ? own : "",
    KEEP_CHILD: options.keepChild === true ? marker("child-release") : "",
  };

  // The stand-in finds the real `flock`, if any, on the PATH the test runner started with.
  const script = [
    "set -eu",
    'export REAL_PATH="$PATH"',
    `export PATH=${shellQuote(standIns)}:"$PATH"`,
    ...Object.entries(settings).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
    `lock=${shellQuote(lock)}`,
    ...holdProvisionLock(),
    ...guardedSection,
  ].join("\n");

  mkdirSync(own);
  const child = spawn(shell, ["-c", script], { stdio: "ignore" });

  const exited = new Promise<Exit>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });

  return {
    hasPaused: () => existsSync(marker("paused")),
    hasBlocked: () => existsSync(marker("blocked")),
    hasEntered: () => events().includes(`enter ${name}`),
    resume: () => {
      writeFileSync(marker("resume"), "");
    },
    release: () => {
      writeFileSync(marker("release"), "");
    },
    releaseChild: () => {
      writeFileSync(marker("child-release"), "");
    },
    kill: () => {
      child.kill("SIGKILL");
    },
    exited,
  };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;

  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting until ${what}; events: ${events().join(", ")}`);
    }

    await delay(5);
  }
}

/** Wait until the contender has either found the lock held or entered the section. */
async function settle(contender: Contender, name: string): Promise<void> {
  await until(() => contender.hasBlocked() || contender.hasEntered(), `${name} blocks or enters`);
}

/**
 * Enter and leave strictly alternate, so no two contenders were ever inside together. A holder
 * that was killed inside never records its leave, so its events are left out.
 */
function expectOneHolderAtATime(killed: string): void {
  let inside: string | undefined;

  for (const event of events().filter((line) => line !== `enter ${killed}`)) {
    const [kind, name] = event.split(" ");

    if (kind === "enter") {
      expect(inside, `${name} entered while ${inside ?? "nobody"} was inside`).toBeUndefined();
      inside = name;
    } else {
      expect(name).toBe(inside);
      inside = undefined;
    }
  }
}

const exitedCleanly = { code: 0, signal: null };

async function waitsWhileHolderIsPausedAfterAcquiring(shell: string): Promise<void> {
  const first = start(shell, "first", { pauseAfterAcquire: true });
  await until(first.hasPaused, "first has taken the lock");

  const second = start(shell, "second");
  await settle(second, "second");
  expect(second.hasEntered(), "second entered a lock whose owner is still alive").toBe(false);

  first.resume();
  await until(first.hasEntered, "first enters");
  first.release();
  expect(await first.exited).toEqual(exitedCleanly);
  await until(second.hasEntered, "second enters after first leaves");

  const third = start(shell, "third");
  await settle(third, "third");
  expect(third.hasEntered(), "third entered while second held the lock").toBe(false);

  second.release();
  await until(third.hasEntered, "third enters after second leaves");
  third.release();

  expect(await second.exited).toEqual(exitedCleanly);
  expect(await third.exited).toEqual(exitedCleanly);
  expect(events()).toEqual([
    "enter first",
    "leave first",
    "enter second",
    "leave second",
    "enter third",
    "leave third",
  ]);
}

async function takesOverFromKilledHolder(shell: string, options: Options): Promise<void> {
  const dead = start(shell, "dead", options);
  const holding = options.pauseAfterAcquire === true ? dead.hasPaused : dead.hasEntered;
  await until(holding, "dead holds the lock");
  dead.kill();
  expect((await dead.exited).signal).toBe("SIGKILL");

  const next = start(shell, "next");
  await until(next.hasEntered, "next takes the dead holder's lock");
  next.release();

  expect(await next.exited).toEqual(exitedCleanly);
}

async function childOfKilledHolderKeepsLock(shell: string): Promise<void> {
  const dead = start(shell, "dead", { keepChild: true });
  await until(dead.hasEntered, "dead holds the lock");
  dead.kill();
  await dead.exited;

  const next = start(shell, "next");
  await settle(next, "next");
  expect(next.hasEntered(), "next entered while the dead holder's child still ran").toBe(false);

  dead.releaseChild();
  await until(next.hasEntered, "next enters once the child exits");
  next.release();

  expect(await next.exited).toEqual(exitedCleanly);
}

/** Contenders that entered the section and have not left it, leaving out a killed holder. */
function occupants(killed: string): readonly string[] {
  const entered = events()
    .filter((line) => line.startsWith("enter "))
    .map((line) => line.slice("enter ".length));

  return entered.filter((name) => name !== killed && !events().includes(`leave ${name}`));
}

async function contendersForDeadHolderEnterOneAtATime(shell: string): Promise<void> {
  const dead = start(shell, "dead");
  await until(dead.hasEntered, "dead holds the lock");

  const waiting = new Map(["one", "two", "three"].map((name) => [name, start(shell, name)]));
  await until(() => [...waiting.values()].every((c) => c.hasBlocked()), "all three block");

  dead.kill();
  await dead.exited;
  await until(() => occupants("dead").length === 1, "one contender takes the dead holder's lock");

  // A newcomer that arrives now must find the lock held by the one contender inside.
  const newcomer = start(shell, "newcomer");
  await settle(newcomer, "newcomer");
  expect(occupants("dead")).toHaveLength(1);
  waiting.set("newcomer", newcomer);

  for (let left = 0; left < waiting.size; left += 1) {
    await until(() => occupants("dead").length === 1, "the next contender enters");
    const [inside] = occupants("dead");
    waiting.get(inside ?? "")?.release();
    await until(() => events().includes(`leave ${inside ?? ""}`), `${inside ?? ""} leaves`);
  }

  for (const contender of waiting.values()) {
    expect(await contender.exited).toEqual(exitedCleanly);
  }

  expectOneHolderAtATime("dead");
  expect(events()).toHaveLength(9);
}

const timeoutMs = 30_000;

describe.each(shells)("the harness provision lock under %s", (shell) => {
  test(
    "a contender waits while the holder is paused right after taking the lock",
    () => waitsWhileHolderIsPausedAfterAcquiring(shell),
    timeoutMs,
  );

  test(
    "a contender takes the lock from a holder killed right after taking it",
    () => takesOverFromKilledHolder(shell, { pauseAfterAcquire: true }),
    timeoutMs,
  );

  test(
    "a contender takes the lock from a holder killed inside the section",
    () => takesOverFromKilledHolder(shell, {}),
    timeoutMs,
  );

  test(
    "a killed holder's surviving child keeps the lock until it exits",
    () => childOfKilledHolderKeepsLock(shell),
    timeoutMs,
  );

  test(
    "three contenders and a newcomer take a dead holder's lock one at a time",
    () => contendersForDeadHolderEnterOneAtATime(shell),
    timeoutMs,
  );
});
