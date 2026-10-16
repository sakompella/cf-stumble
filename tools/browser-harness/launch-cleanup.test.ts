import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { HarnessChrome } from "./browser.mts";

/**
 * A stand-in for Chrome: a shell script that starts one child, like a renderer, and then either
 * exits at once or publishes a DevTools port whose endpoint never completes the WebSocket
 * handshake. The test reads the child's pid from `child.pid` to check that the whole process group
 * is killed, not only the process that was launched.
 */
const FAKE_CHROME = `#!/bin/sh
for argument in "$@"; do
  case "$argument" in --user-data-dir=*) profile="\${argument#--user-data-dir=}" ;; esac
done
sleep 300 &
echo "$!" > "$FAKE_CHROME_STATE/child.pid"
echo "$profile" > "$FAKE_CHROME_STATE/profile"
if [ "$FAKE_CHROME_MODE" = "exit-early" ]; then
  exit 1
fi
printf '%s\\n/devtools/browser/fake\\n' "$FAKE_CHROME_PORT" > "$profile/DevToolsActivePort"
wait
`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 40 && isAlive(pid); attempt += 1) {
    await sleep(50);
  }

  assert.equal(isAlive(pid), false, `process ${pid} is still running`);
}

type HangingEndpoint = Readonly<{ port: number; close: () => void }>;

/** A DevTools HTTP endpoint that names a WebSocket URL, then never answers the upgrade. */
async function startHangingEndpoint(): Promise<HangingEndpoint> {
  const releaseSockets: (() => void)[] = [];

  const server: Server = createServer((_request, response) => {
    response.end(
      JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${listeningPort()}/never` }),
    );
  });

  const listeningPort = (): number => {
    const address = server.address();

    if (!(address instanceof Object)) {
      throw new Error("the fake DevTools endpoint is not listening on a TCP port");
    }

    return address.port;
  };

  server.on("upgrade", (_request, socket) => {
    releaseSockets.push(() => {
      socket.destroy();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    port: listeningPort(),
    close: () => {
      for (const release of releaseSockets) {
        release();
      }

      server.closeAllConnections();
      server.close();
    },
  };
}

describe("HarnessChrome.launch cleanup", () => {
  let workDir = "";
  let endpoint: HangingEndpoint;
  const environmentBefore = { ...process.env };

  before(async () => {
    workDir = await mkdtemp(join(tmpdir(), "cf-stumble-launch-test-"));
    const executable = join(workDir, "fake-chrome");
    await writeFile(executable, FAKE_CHROME);
    await chmod(executable, 0o755);
    endpoint = await startHangingEndpoint();

    process.env.CF_STUMBLE_CHROME = executable;
    process.env.FAKE_CHROME_STATE = workDir;
    process.env.FAKE_CHROME_PORT = String(endpoint.port);
  });

  after(async () => {
    endpoint.close();
    process.env = environmentBefore;
    await rm(workDir, { recursive: true, force: true });
  });

  async function assertNothingLeft(): Promise<void> {
    const profile = (await readFile(join(workDir, "profile"), "utf8")).trim();
    const child = Number((await readFile(join(workDir, "child.pid"), "utf8")).trim());

    await waitUntilGone(child);
    assert.equal(await stat(profile).catch(() => null), null, `profile ${profile} was left behind`);
  }

  it("stops everything when Chrome exits before it publishes a DevTools port", async () => {
    process.env.FAKE_CHROME_MODE = "exit-early";

    await assert.rejects(HarnessChrome.launch(10_000), /Chrome exited \(1\) before the harness/u);
    await assertNothingLeft();
  });

  it("stops everything when the DevTools attach times out", async () => {
    process.env.FAKE_CHROME_MODE = "hang-on-attach";

    await assert.rejects(HarnessChrome.launch(1_000), /not attached within 1000ms/u);
    await assertNothingLeft();
  });
});
