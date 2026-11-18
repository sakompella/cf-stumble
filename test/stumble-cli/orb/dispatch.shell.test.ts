import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { dispatch } from "../../../src/stumble-cli/orb/dispatch.js";
import { eventually } from "../../eventually.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "orb-dispatch-test-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
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

  const pid = await eventually(async () => {
    const written = await dispatchPid();

    expect(written).toBeGreaterThan(0);

    return written;
  });

  expect(alive(pid)).toBe(true);

  await Effect.runPromise(Fiber.interrupt(fiber));

  await eventually(() => {
    expect(alive(pid)).toBe(false);
  });
});

const dockerDispatch = fileURLToPath(
  new URL("../../../src/stumble-cli/orb/docker-dispatch.sh", import.meta.url),
);

test.each(["stop", "delete"] as const)(
  "a %s that the container engine refuses fails with the engine's error",
  async (job) => {
    const engine = join(directory, "docker");

    await writeFile(engine, `#!/usr/bin/env bash\necho "engine refused $*" >&2\nexit 125\n`);
    await chmod(engine, 0o755);
    vi.stubEnv("PATH", `${directory}:${process.env["PATH"] ?? ""}`);
    vi.stubEnv("STUMBLE_IMAGE", "image");

    const result = await Effect.runPromise(
      dispatch(dockerDispatch, { job, container: "c1", egressPort: 9, env: {} }),
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("engine refused rm -f stumble-c1");
  },
);
