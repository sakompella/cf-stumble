import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  decodeBody,
  hostFrame,
  ORB_PING,
  orbJob,
  type ProviderFrame,
} from "../../../src/orb-protocol.js";
import { orbCommands, type OrbPorts } from "../../../src/stumble-cli/orb/commands.js";
import { runCommandTree, type CommandNode } from "../../../src/stumble-cli/tree.js";
import { startFakeContainer, startFakeHost, type FakeHost } from "./fake-host.js";

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
  vi.useRealTimers();
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
  host = await startFakeHost({ greeting: startC1 });
  const running = provider(await dispatchScript("true"));

  await until(async () => (await jobs()).includes("delete c1"));
  expect(await jobs()).toEqual(["start c1", "delete c1"]);
  running.stop();
  await running.exitCode;
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

test("a closed connection interrupts the running handler", async () => {
  host = await startFakeHost({
    greeting: hostFrame.job({ id: 1, job: orbJob.stop({ container: "c1" }) }),
  });
  const script = join(directory, "dispatch.sh");

  await writeFile(
    script,
    `#!/usr/bin/env bash
case "$STUMBLE_JOB" in
  stop) echo $$ > "${directory}/pid"; exec sleep 30 ;;
esac
`,
  );
  await chmod(script, 0o755);

  const running = provider(script);

  await until(async () => (await dispatchPid()) > 0);
  const pid = await dispatchPid();
  expect(alive(pid)).toBe(true);

  host.closeLink();

  await until(() => !alive(pid));
  expect(alive(pid)).toBe(false);

  running.stop();
  await running.exitCode;
});

test("a stop while connected stops the running container and closes the link", async () => {
  host = await startFakeHost({ greeting: startC1 });
  const running = provider(await dispatchScript('echo "127.0.0.1:9"'));

  await until(async () => (await jobs()).includes("wait c1"));
  running.stop();

  expect(await running.exitCode).toBe(0);
  expect(await jobs()).toContain("stop c1");
  await until(() => host.closedLinks() === 1);
  expect(host.attempts()).toBe(1);
});

type FetchResult = Extract<ProviderFrame, { _tag: "fetch-result" }>;

function containerFetch(id: number, path: string) {
  return hostFrame.fetch({ id, port: 8080, method: "GET", path, headers: [], body: null });
}

function fetchResult(id: number): FetchResult | undefined {
  return host
    .received()
    .find(
      (frame): frame is FetchResult =>
        frame !== ORB_PING && frame._tag === "fetch-result" && frame.id === id,
    );
}

async function answered(id: number): Promise<FetchResult> {
  await until(() => fetchResult(id) !== undefined);

  const frame = fetchResult(id);

  if (frame === undefined) throw new Error(`no answer to ${id}`);

  return frame;
}

async function containerAnswer(container: string): Promise<FetchResult> {
  host = await startFakeHost({ greeting: startC1 });

  const running = provider(await dispatchScript(`echo "${container}"`));

  await until(async () => (await jobs()).includes("wait c1"));
  host.send(containerFetch(2, "/"));

  const answer = await answered(2);

  running.stop();
  await running.exitCode;

  return answer;
}

test("the provider returns a redirect from the container without following it", async () => {
  let secretHits = 0;

  const secret = await startFakeContainer((_request, response) => {
    secretHits += 1;
    response.end("secret");
  });

  const location = `http://${secret.address}/secret`;

  const container = await startFakeContainer((_request, response) => {
    response.writeHead(302, { location }).end();
  });

  const moved = await containerAnswer(container.address);

  expect(moved.status).toBe(302);
  expect(moved.headers).toContainEqual(["location", location]);
  expect(secretHits).toBe(0);
  container.close();
  secret.close();
});

test("a compressed answer reaches the Host decoded, without the headers of the compressed body", async () => {
  const zipped = gzipSync("decoded bytes");

  const container = await startFakeContainer((_request, response) => {
    response
      .writeHead(200, { "content-encoding": "gzip", "content-length": zipped.length })
      .end(zipped);
  });

  const answer = await containerAnswer(container.address);
  const names = answer.headers.map(([name]) => name);

  expect(names).not.toContain("content-encoding");
  expect(names).not.toContain("content-length");
  expect(new TextDecoder().decode(decodeBody(answer.body ?? ""))).toBe("decoded bytes");
  container.close();
});

function pings(): number {
  return host.received().filter((frame) => frame === ORB_PING).length;
}

function greeted(): boolean {
  return host.received().some((frame) => frame !== ORB_PING && frame._tag === "hello");
}

async function pingTick(): Promise<void> {
  const before = pings();

  vi.advanceTimersByTime(30_000);
  await until(() => pings() > before);
  await pause(100);
}

test("a Host that answers each ping keeps the link", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  host = await startFakeHost({});

  const running = provider(await dispatchScript("true"));

  await until(greeted);
  await pingTick();
  await pingTick();
  await pingTick();
  await pause(1_300);

  expect(host.attempts()).toBe(1);
  expect(host.closedLinks()).toBe(0);

  running.stop();
  await running.exitCode;
});

test("a Host that stops answering pings is dropped at the second ping and connected again", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  host = await startFakeHost({ answersPings: false });

  const running = provider(await dispatchScript("true"));

  await until(greeted);
  await pingTick();
  expect(host.attempts()).toBe(1);

  vi.advanceTimersByTime(30_000);
  await until(() => host.attempts() === 2);
  expect(host.closedLinks()).toBe(1);

  running.stop();
  await running.exitCode;
});
