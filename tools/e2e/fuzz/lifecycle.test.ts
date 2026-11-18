import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import * as Predicate from "effect/Predicate";
import { GitHub } from "../github.mts";
import { Owner } from "../owner-api.mts";
import { Target } from "../target.mts";
import { fuzz } from "./lifecycle.mts";

class OneCommit extends GitHub {
  override mainCommits(): Promise<readonly string[]> {
    return Promise.resolve(["a".repeat(40)]);
  }
}

class LocalTarget extends Target {
  override readonly github = new OneCommit("");
}

let statusReads = 0;

const server = createServer((request, response) => {
  if (request.url === "/api/status") {
    statusReads += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ activeGeneration: { epoch: 1 } }));
  } else {
    request.socket.destroy();
  }
});

after(() => {
  server.close();
});

function listen(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const bound = server.address();

      if (bound === null || Predicate.isString(bound)) reject(new Error("no port"));
      else resolve(`http://127.0.0.1:${bound.port}`);
    });
  });
}

it("a lifecycle fuzz run whose first submit fails reads no status after it rejects", async () => {
  const url = await listen();
  const owner = new Owner(url, "password");

  const target = new LocalTarget({
    runId: "lifecycle-setup-fails",
    url,
    stage: undefined,
    password: "password",
    env: {},
  });

  await assert.rejects(
    fuzz({
      area: "lifecycle",
      seed: 1,
      deadlineMs: Date.now() + 60_000,
      signal: new AbortController().signal,
      owner,
      password: "password",
      target,
      secrets: [],
      commands: [],
      log: () => {},
    }),
    TypeError,
  );

  const atRejection = statusReads;

  await sleep(2_500);

  assert.equal(statusReads, atRejection, "the status poller kept polling after the run rejected");
});
