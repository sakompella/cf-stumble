import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, describe, it } from "node:test";
import * as Predicate from "effect/Predicate";
import { connectPayload } from "../browser-harness/fixtures.mts";
import { Owner } from "./owner-api.mts";
import { forgetRestoreState, loadRestoreState, saveRestoreState } from "./restore-state.mts";
import { Target } from "./target.mts";
import { productLoop } from "./workflows.mts";

const PROJECT = "e2e-project";

type Project = { running: boolean; removed: boolean; refuses: boolean };

function view(project: Project): string {
  const live = project.running ? { run: {} } : {};

  return `${JSON.stringify([["r", { entries: [], docs: { "pi.live": live, "pi.inbox": { items: [] } } }]])}\n`;
}

async function owner(project: Project): Promise<Readonly<{ url: string; server: Server }>> {
  const server = createServer((request, response) => {
    const answer = (status: number, body: string) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body);
    };

    if (request.url === `/api/projects/${PROJECT}/abort`) {
      project.running = false;
      answer(200, JSON.stringify({ ok: true }));
    } else if (request.url === `/api/projects/${PROJECT}/events`) {
      answer(200, view(project));
    } else if (
      request.url === `/api/projects/${PROJECT}/disconnect` &&
      (project.running || project.refuses)
    ) {
      answer(409, JSON.stringify({ ok: false, problem: { code: "run-active" } }));
    } else if (request.url === `/api/projects/${PROJECT}/disconnect`) {
      project.removed = true;
      answer(200, JSON.stringify({ ok: true, projectId: PROJECT, workspace: "removed" }));
    } else {
      answer(404, JSON.stringify({ ok: false, problem: { code: "unknown-project-id" } }));
    }
  });

  return { url: await listen(server), server };
}

function listen(server: Server): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const bound = server.address();

      if (bound === null || Predicate.isString(bound)) reject(new Error("no port"));
      else resolve(`http://127.0.0.1:${bound.port}`);
    });
  });
}

function cleanupTarget(url: string): Target {
  const runId = randomBytes(4).toString("hex");

  saveRestoreState(runId, { label: undefined, project: PROJECT });

  return new Target({ runId, url, stage: undefined, password: "pw", env: {} });
}

describe("restoring a target the e2e run connected a project to", () => {
  const servers: Server[] = [];
  const runs: string[] = [];

  after(() => {
    for (const server of servers) server.close();

    for (const runId of runs) forgetRestoreState(runId);
  });

  it("stops the project's run before it disconnects, so the disconnect is accepted", async () => {
    const project = { running: true, removed: false, refuses: false };
    const { url, server } = await owner(project);

    servers.push(server);

    const target = cleanupTarget(url);

    runs.push(target.runId);
    await target.restore();

    assert.equal(project.removed, true);
    assert.equal(loadRestoreState(target.runId).project, undefined);
  });

  it("fails and keeps the project in the restore record when the disconnect is refused", async () => {
    const project = { running: false, removed: false, refuses: true };
    const { url, server } = await owner(project);

    servers.push(server);

    const target = cleanupTarget(url);

    runs.push(target.runId);
    await assert.rejects(target.restore(), /run-active/u);

    assert.equal(project.removed, false);
    assert.equal(loadRestoreState(target.runId).project, PROJECT);
  });
});

describe("an e2e run against an instance where the owner connected the project before the run", () => {
  it("sends no turn to the owner's project and leaves it connected after the cleanup", async () => {
    const requests: string[] = [];

    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.writeHead(200, { "content-type": "application/json" });

      if (request.url === "/api/projects/connect") {
        response.end(JSON.stringify(connectPayload(true)));
      } else if (request.url?.endsWith("/events") === true) {
        response.end(view({ running: false, removed: false, refuses: false }));
      } else if (request.url?.endsWith("/disconnect") === true) {
        response.end(JSON.stringify({ ok: true, projectId: "owned", workspace: "removed" }));
      } else {
        response.end(JSON.stringify({ ok: true }));
      }
    });

    const url = await listen(server);

    const target = new Target({
      runId: randomBytes(4).toString("hex"),
      url,
      stage: undefined,
      password: "pw",
      env: {},
    });

    const run = {
      id: target.runId,
      owner: new Owner(url, "pw"),
      github: target.github,
      password: "pw",
      signal: new AbortController().signal,
    };

    try {
      const failure = await productLoop(run, (projectId) => {
        target.connectedProject = projectId;
      }).then(() => "", String);

      await target.restore();

      assert.deepEqual(requests, ["POST /api/projects/connect"]);
      assert.match(failure, /already connected/u);
    } finally {
      server.close();
      forgetRestoreState(target.runId);
    }
  });
});
