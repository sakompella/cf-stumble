import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { execute } from "./process.mts";
import { Skip, Steps } from "./steps.mts";

const MINUTE = 60_000;

const repoRoot = resolve(import.meta.dirname, "../..");

let scratch = "";

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "steps-test-"));
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

async function pidIn(file: string): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const text = readFileSync(file, "utf8").trim();

    if (text !== "") return Number(text);

    await sleep(100);
  }

  throw new Error(`${file} stayed empty`);
}

describe("a step's outcome", () => {
  it("is a failure when the work throws an error whose message is empty", async () => {
    const steps = new Steps();

    assert.equal(
      await steps.run("empty message", MINUTE, () => Promise.reject(new Error(""))),
      false,
    );
    assert.equal(steps.report("steps"), false);
  });

  it("passes when the work finishes, and a skip with no reason does not fail the run", async () => {
    const steps = new Steps();

    assert.equal(await steps.run("finishes", MINUTE, () => Promise.resolve()), true);
    assert.equal(await steps.run("skipped", MINUTE, () => Promise.reject(new Skip(""))), true);
    assert.equal(steps.report("steps"), true);
  });
});

describe("a step that is stopped", () => {
  it("has no process left running when run returns, even a grandchild of the work", async () => {
    const steps = new Steps();
    const file = join(scratch, "limit-pid");

    const passed = await steps.run("past its limit", 1_000, async () => {
      await execute("sh", ["-c", `sleep 30 & echo $! > ${file}; wait`]);
    });

    const pid = await pidIn(file);

    try {
      assert.equal(passed, false);
      assert.equal(alive(pid), false, "the work's process still runs after the step failed");
    } finally {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
  });

  it("does not start the work of a step that comes after an interrupt", async () => {
    const steps = new Steps();
    let started = false;

    process.emit("SIGINT", "SIGINT");

    const passed = await steps.run("after the interrupt", MINUTE, () => {
      started = true;

      return Promise.resolve();
    });

    assert.equal(passed, false);
    assert.equal(started, false);
    assert.equal(steps.report("steps"), false);
  });

  it("still runs a cleanup step after an interrupt", async () => {
    const steps = new Steps();

    process.emit("SIGINT", "SIGINT");
    steps.startCleanup();

    assert.equal(await steps.run("cleanup", MINUTE, () => Promise.resolve()), true);
  });
});

describe("a stopped step's process that ignores the termination request", () => {
  it("is killed when the work started it", { timeout: 30_000 }, async () => {
    const steps = new Steps();
    const file = join(scratch, "stubborn-pid");

    const passed = await steps.run("stubborn", 500, async () => {
      await execute("sh", ["-c", `trap '' TERM; echo $$ > ${file}; sleep 30 & wait`]);
    });

    const pid = await pidIn(file);

    try {
      assert.equal(passed, false);
      assert.equal(alive(pid), false);
    } finally {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
  });

  it("is killed when it is a grandchild that closed its output", { timeout: 30_000 }, async () => {
    const steps = new Steps();
    const file = join(scratch, "detached-pid");
    const grandchild = `trap '' TERM; echo \\$\\$ > ${file}; exec sleep 30`;

    const passed = await steps.run("detached", 500, async () => {
      await execute("sh", ["-c", `sh -c "${grandchild}" </dev/null >/dev/null 2>&1 & wait`]);
    });

    const pid = await pidIn(file);

    try {
      assert.equal(passed, false);
      assert.equal(alive(pid), false, "the grandchild still runs after the step failed");
    } finally {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
  });
});

describe("cleanup under the terminal's Ctrl-C", () => {
  it("finishes the child that the interrupt would reach through the process group", async () => {
    const done = join(scratch, "cleanup-done");

    const script = [
      'import { Steps } from "./tools/e2e/steps.mts";',
      'import { execute } from "./tools/e2e/process.mts";',
      "const steps = new Steps();",
      "steps.startCleanup();",
      `await steps.run("cleanup", 60_000, () => execute("sh", ["-c", "echo up >&2; sleep 2; echo finished > ${done}"], { echo: true }));`,
    ].join("\n");

    const group = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { cwd: repoRoot, detached: true, stdio: ["ignore", "ignore", "pipe"] },
    );

    const exited = once(group, "close");

    let stderr = "";

    await new Promise<void>((started) => {
      group.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();

        if (stderr.includes("up\n")) started();
      });
    });

    process.kill(-(group.pid ?? 0), "SIGINT");
    await exited;

    assert.equal(readFileSync(done, "utf8"), "finished\n");
  });
});
