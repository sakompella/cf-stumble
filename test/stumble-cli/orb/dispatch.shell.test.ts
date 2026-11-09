import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { afterEach, beforeEach, expect, test } from "vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { dispatch } from "../../../src/stumble-cli/orb/dispatch.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "orb-dispatch-test-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

async function until(done: () => boolean | Promise<boolean>): Promise<void> {
  for (let tries = 0; tries < 200 && !(await done()); tries += 1) await pause(25);
}

async function dispatchPid(): Promise<number> {
  return Number(await readFile(join(directory, "pid"), "utf8").catch(() => ""));
}

test("an interrupted dispatch leaves no child process", async () => {
  const script = join(directory, "dispatch.sh");

  await writeFile(script, `#!/usr/bin/env bash\necho $$ > "${directory}/pid"\nexec sleep 30\n`);
  await chmod(script, 0o755);

  const fiber = Effect.runFork(
    dispatch(script, { job: "stop", container: "c1", egressPort: 9, env: {} }),
  );

  await until(async () => (await dispatchPid()) > 0);
  const pid = await dispatchPid();
  expect(alive(pid)).toBe(true);

  await Effect.runPromise(Fiber.interrupt(fiber));

  await until(() => !alive(pid));
  expect(alive(pid)).toBe(false);
});
