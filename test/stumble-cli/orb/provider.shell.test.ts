import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { afterEach, beforeEach, expect, test } from "vitest";
import { hostFrame, orbJob } from "../../../src/orb-protocol.js";
import { orbCommands, type OrbPorts } from "../../../src/stumble-cli/orb/commands.js";
import { runCommandTree, type CommandNode } from "../../../src/stumble-cli/tree.js";
import { startFakeHost, type FakeHost } from "./fake-host.js";

const root: CommandNode<OrbPorts> = { name: "stumble", summary: "", subcommands: [orbCommands] };

const startC1 = hostFrame.job({ id: 1, job: orbJob.start({ container: "c1", env: {} }) });

type Provider = Readonly<{ stop(): void; exitCode: Promise<number> }>;

let directory: string;

let host: FakeHost;

async function until(done: () => boolean | Promise<boolean>): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (await done()) return;

    await pause(25);
  }

  throw new Error("timed out waiting");
}

async function dispatchScript(start: string): Promise<string> {
  const script = join(directory, "dispatch.sh");

  await writeFile(
    script,
    `#!/usr/bin/env bash
echo "$STUMBLE_JOB $STUMBLE_CONTAINER" >> "${directory}/jobs"
case "$STUMBLE_JOB" in
  start) ${start} ;;
  stop | delete) touch "${directory}/stopped" ;;
  wait) while [ ! -e "${directory}/stopped" ]; do sleep 0.05; done ;;
esac
`,
  );
  await chmod(script, 0o755);

  return script;
}

function provider(script: string): Provider {
  const stopping = new AbortController();

  const ports: OrbPorts = {
    env: { STUMBLE_ORB_URL: host.origin, STUMBLE_ORB_TOKEN: "token" },
    signal: stopping.signal,
    platform: "linux",
    arch: "x64",
    log: () => {},
  };

  const finished = runCommandTree(root, ["orb", "provider", script], ports);

  return {
    exitCode: finished.then((output) => output.exitCode),
    stop: () => {
      stopping.abort();
    },
  };
}

async function jobs(): Promise<string[]> {
  const text = await readFile(join(directory, "jobs"), "utf8").catch(() => "");

  return text.split("\n").filter((line) => line !== "");
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "orb-provider-test-"));
});

afterEach(async () => {
  host.close();
  await rm(directory, { recursive: true, force: true });
});

test("a stop during the backoff ends the provider and it does not connect again", async () => {
  host = await startFakeHost();
  const running = provider(await dispatchScript("true"));

  await until(() => host.attempts() === 1);
  await pause(200);
  running.stop();

  expect(await running.exitCode).toBe(0);
  await pause(1_300);
  expect(host.attempts()).toBe(1);
});

test("a start that prints no address removes the container it created", async () => {
  host = await startFakeHost(startC1);
  const running = provider(await dispatchScript("true"));

  await until(async () => (await jobs()).includes("delete c1"));
  expect(await jobs()).toEqual(["start c1", "delete c1"]);
  running.stop();
  await running.exitCode;
});

test("a stop while connected stops the running container and closes the link", async () => {
  host = await startFakeHost(startC1);
  const running = provider(await dispatchScript('echo "127.0.0.1:9"'));

  await until(async () => (await jobs()).includes("wait c1"));
  running.stop();

  expect(await running.exitCode).toBe(0);
  expect(await jobs()).toContain("stop c1");
  await until(() => host.closedLinks() === 1);
  expect(host.attempts()).toBe(1);
});
