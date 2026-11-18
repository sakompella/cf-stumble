import assert from "node:assert/strict";
import { afterEach, beforeEach, it, mock } from "node:test";
import * as Schema from "effect/Schema";
import { GitHub } from "../github.mts";
import { Owner } from "../owner-api.mts";
import { Target } from "../target.mts";
import { fuzz as fuzzExec } from "./exec.mts";
import { fuzzGit } from "./git-fuzz.mts";

const URL_BASE = "http://owner.invalid";

const ENTRIES = `${URL_BASE}/api/projects/harness/entries`;

const COMMIT = "a".repeat(40);

const WORKSPACE_PATH = /\/workspace\/[^\s'"&;|)]+/gu;

const REMOVAL = /rm -rf((?:\s+[^\s&;|]+)+)/gu;

const Steps = Schema.fromJsonString(
  Schema.Array(
    Schema.Union([
      Schema.Struct({ tool: Schema.String, args: Schema.Struct({ command: Schema.String }) }),
      Schema.Struct({ command: Schema.String, cwd: Schema.optional(Schema.String) }),
    ]),
  ),
);

const Message = Schema.fromJsonString(Schema.Struct({ content: Schema.String }));

type Step = Readonly<{ command: string; cwd?: string | undefined }>;

type Entry = Readonly<{ id: number; kind: string; model: readonly unknown[] }>;

const EMPTY = { bytes: 0, lines: 0, sha256: "", text: "", head: "", tail: "" };

const REPORTED = JSON.stringify({
  ok: true,
  exitCode: 0,
  error: null,
  ms: 1,
  stdout: EMPTY,
  stderr: EMPTY,
  spill: null,
});

function removeUnder(live: Set<string>, root: string): void {
  for (const path of live) if (path === root || path.startsWith(`${root}/`)) live.delete(path);
}

class Workspace {
  readonly steps: Step[] = [];
  readonly #entries: Entry[] = [];

  #add(kind: string, text: string): void {
    this.#entries.push({ id: this.#entries.length + 1, kind, model: [{ content: [{ text }] }] });
  }

  #run(content: string): void {
    const [, scripted] = /^fuzz-steps (.*)$/su.exec(content) ?? [];
    const [, exec] = /^fuzz-exec:(.*)$/su.exec(content) ?? [];

    const steps = Schema.decodeSync(Steps)(scripted ?? exec ?? "[]").map((step) =>
      "args" in step ? { command: step.args.command } : step,
    );

    this.steps.push(...steps);

    if (scripted === undefined) {
      for (const _ of steps) this.#add("pi.tool-result", REPORTED);
    } else {
      this.#add("pi.assistant", `fuzz-results ${JSON.stringify(steps.map(() => ""))}`);
    }
  }

  #entriesPage(query: URLSearchParams): readonly Entry[] {
    const limit = Number(query.get("limit"));

    if (query.get("order") === "ascending") {
      const min = Number(query.get("min"));

      return this.#entries.filter((entry) => entry.id >= min).slice(0, limit);
    }

    return this.#entries.toReversed().slice(0, limit);
  }

  answer(url: URL, body: string): Response {
    if (url.pathname === "/api/status") {
      return Response.json({
        activeGeneration: {
          generation: { label: 1, harnessCommit: COMMIT, status: "ready" },
          epoch: 1,
        },
        mainAhead: null,
      });
    }

    if (url.pathname.endsWith("/messages")) {
      this.#run(Schema.decodeSync(Message)(body).content);

      return Response.json({}, { status: 202 });
    }

    if (url.pathname.endsWith("/events")) {
      const docs = { "pi.live": {}, "pi.inbox": { items: [] } };

      return new Response(`${JSON.stringify([["r", { entries: [], docs }]])}\n`);
    }

    if (url.href.startsWith(ENTRIES)) {
      return Response.json({ items: this.#entriesPage(url.searchParams) });
    }

    return Response.json({});
  }

  left(): readonly string[] {
    const live = new Set<string>();

    for (const { command, cwd } of this.steps) {
      for (const [, removed = ""] of command.matchAll(REMOVAL)) {
        for (const root of removed.trim().split(/\s+/u)) removeUnder(live, root);
      }

      for (const [path] of command.replaceAll(REMOVAL, "").matchAll(WORKSPACE_PATH)) live.add(path);

      if (cwd !== undefined) live.add(cwd);
    }

    return [...live];
  }
}

class FacetInstalled extends GitHub {
  override fileAt(): Promise<string | undefined> {
    return Promise.resolve("installed");
  }
}

class LocalTarget extends Target {
  override readonly github = new FacetInstalled("");
}

let workspace = new Workspace();

beforeEach(() => {
  workspace = new Workspace();
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (url.origin !== URL_BASE) return new Response(null, { status: 404 });

    return workspace.answer(url, await request.text());
  });
});

afterEach(() => {
  mock.restoreAll();
});

it("a git fuzz run leaves no scratch repository in the workspace", async () => {
  const owner = new Owner(URL_BASE, "password");

  await fuzzGit({
    seed: 1,
    deadline: Date.now() + 1_000,
    runId: "scratch",
    owner,
    github: new GitHub(""),
    token: "",
    signal: new AbortController().signal,
  });

  assert.ok(workspace.steps.length > 0, "the run sent no steps");
  assert.deepEqual(workspace.left(), []);
});

it("an exec fuzz run leaves no case directory in the workspace", async () => {
  const owner = new Owner(URL_BASE, "password");

  await fuzzExec({
    area: "exec",
    seed: 1,
    deadlineMs: Date.now() + 60_000,
    signal: new AbortController().signal,
    owner,
    password: "password",
    target: new LocalTarget({
      runId: "scratch",
      url: URL_BASE,
      stage: undefined,
      password: "password",
      env: {},
    }),
    secrets: [],
    commands: ["head -c 1000000 /dev/zero > retained.bin"],
    log: () => {},
  });

  assert.ok(workspace.steps.length > 0, "the run sent no steps");
  assert.deepEqual(workspace.left(), []);
});
