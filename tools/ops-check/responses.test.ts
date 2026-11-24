import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type * as Schema from "effect/Schema";
import { parseUsage } from "./fetch.mts";
import { parseInvocations, parseModelCalls, parseSessionFailures } from "./telemetry.mts";
import {
  parseLatestDeployment,
  parseStaleCalls,
  versionFindings,
  type StaleCall,
  type VersionInput,
} from "./versions.mts";

const MEMORY_BYTES = 8 * 1024 ** 3;

const usageResponse = (groups: readonly Schema.JsonObject[]): Schema.Json => ({
  data: { viewer: { accounts: [{ containersUsageAdaptiveGroups: groups }] } },
});

const group = (bucket: string, allocatedMemory: number): Schema.JsonObject => ({
  dimensions: { datetimeFiveMinutes: bucket },
  sum: { allocatedMemory },
});

describe("parseUsage", () => {
  it("turns byte-seconds into running minutes and sums instances in one bucket", () => {
    const bucket = "2026-10-01T00:00:00Z";
    const fiveMinutes = MEMORY_BYTES * 5 * 60;

    const [only, ...rest] = parseUsage(
      usageResponse([group(bucket, fiveMinutes / 2), group(bucket, fiveMinutes / 2)]),
      MEMORY_BYTES,
    );

    assert.equal(rest.length, 0);
    assert.equal(only?.startMs, Date.parse(bucket));
    assert.equal(only?.runningMinutes, 5);
  });

  it("reads a successful answer, which GraphQL sends with errors set to null", () => {
    const answer = {
      errors: null,
      data: { viewer: { accounts: [{ containersUsageAdaptiveGroups: [] }] } },
    };

    assert.deepEqual(parseUsage(answer, MEMORY_BYTES), []);
  });

  it("refuses a response at its row limit, which may be cut off", () => {
    const full = Array.from({ length: 5000 }, () => group("2026-10-01T00:00:00Z", 1));

    assert.throws(() => parseUsage(usageResponse(full), MEMORY_BYTES), /row limit/u);
  });
});

describe("parseInvocations", () => {
  it("skips log lines, which share the query but carry no wall time", () => {
    const invocation: Schema.JsonObject = {
      timestamp: 2,
      $workers: { wallTimeMs: 5, event: { request: { url: "https://x.test/api/status" } } },
    };

    const logLine: Schema.JsonObject = {
      timestamp: 1,
      source: { event: "workspace.backend.connected" },
      $workers: { event: { request: { url: "http://computer.internal/api" } } },
    };

    const parsed = parseInvocations({ result: { events: { events: [logLine, invocation] } } });

    assert.deepEqual(parsed, [{ endMs: 2, wallTimeMs: 5, route: "/api/status" }]);
  });

  it("refuses a response at its row limit, which may be cut off", () => {
    const row: Schema.JsonObject = {
      timestamp: 1,
      $workers: { wallTimeMs: 1, event: { request: { url: "https://x.test/health" } } },
    };

    const events = Array.from({ length: 2000 }, () => row);

    assert.throws(() => parseInvocations({ result: { events: { events } } }), /most it gives/u);
  });
});

describe("parseSessionFailures", () => {
  it("keeps only session-failed events, with their cause", () => {
    const failed: Schema.JsonObject = {
      timestamp: 3,
      source: { event: "facet.session-failed", cause: "storage reset" },
    };

    const other: Schema.JsonObject = { timestamp: 4, source: { event: "run.settled" } };

    const parsed = parseSessionFailures({ result: { events: { events: [other, failed] } } });

    assert.deepEqual(parsed, [{ atMs: 3, cause: "storage reset" }]);
  });
});

describe("parseModelCalls", () => {
  it("keeps model.call events with their prompt and cached tokens", () => {
    const call: Schema.JsonObject = {
      timestamp: 3,
      source: { event: "model.call", promptTokens: 100, cachedTokens: 80 },
    };

    const other: Schema.JsonObject = { timestamp: 4, source: { event: "run.settled" } };

    assert.deepEqual(
      parseModelCalls({ result: { events: { events: [other, call] } } }, "model.call"),
      { calls: [{ provider: "workers-ai", promptTokens: 100, cachedTokens: 80 }], sample: false },
    );
  });

  it("names ChatGPT as the provider of an answered chatgpt.model-call and skips its failures", () => {
    const ok: Schema.JsonObject = {
      timestamp: 3,
      source: { event: "chatgpt.model-call", outcome: "ok", promptTokens: 50, cachedTokens: 40 },
    };

    const refused: Schema.JsonObject = {
      timestamp: 4,
      source: { event: "chatgpt.model-call", outcome: "refused" },
    };

    assert.deepEqual(
      parseModelCalls({ result: { events: { events: [refused, ok] } } }, "chatgpt.model-call"),
      { calls: [{ provider: "chatgpt", promptTokens: 50, cachedTokens: 40 }], sample: false },
    );
  });

  it("marks a full page as a sample instead of failing", () => {
    const call: Schema.JsonObject = {
      timestamp: 3,
      source: { event: "model.call", promptTokens: 100, cachedTokens: 80 },
    };

    const page = Array.from({ length: 2000 }, () => call);

    assert.equal(
      parseModelCalls({ result: { events: { events: page } } }, "model.call").sample,
      true,
    );
  });
});

const DEPLOYED = Date.parse("2026-10-01T12:00:00Z");

const NEW_VERSION = "61f8dbef-ce17-45f0-96aa-2983628bd8e8";

const OLD_VERSION = "d3670911-5aaa-4f1b-8d1e-0123456789ab";

const deployment = (createdOn: string, versionId: string): Schema.JsonObject => ({
  created_on: createdOn,
  versions: [{ version_id: versionId, percentage: 100 }],
});

const row = (entrypoint: string, timestamp: number): Schema.JsonObject => ({
  timestamp,
  $workers: { entrypoint, scriptVersion: { id: OLD_VERSION } },
});

const stale = (durableObject: string, minutesAfter: number): StaleCall => ({
  durableObject,
  atMs: DEPLOYED + minutesAfter * 60_000,
  version: OLD_VERSION,
});

const input = (staleCalls: readonly StaleCall[]): VersionInput => ({
  worker: "cf-stumble",
  nowMs: DEPLOYED + 60 * 60_000,
  state: {
    status: "ok",
    data: { deployment: { deployedAtMs: DEPLOYED, versionIds: [NEW_VERSION] }, staleCalls },
  },
});

describe("parseLatestDeployment", () => {
  it("takes the newest deployment whatever order the list comes in", () => {
    hegel.test((tc) => {
      const minutes = tc.draw(
        gs.arrays(gs.integers({ minValue: 0, maxValue: 100_000 }), {
          unique: true,
          minSize: 1,
          maxSize: 8,
        }),
      );

      const deployments = minutes.map((minute) =>
        deployment(new Date(DEPLOYED + minute * 60_000).toISOString(), `version-${minute}`),
      );

      const newest = Math.max(...minutes);

      assert.deepEqual(parseLatestDeployment({ result: { deployments } }), {
        deployedAtMs: DEPLOYED + newest * 60_000,
        versionIds: [`version-${newest}`],
      });
    });
  });

  it("refuses an empty list instead of reading it as no skew", () => {
    assert.throws(() => parseLatestDeployment({ result: { deployments: [] } }), /no deployment/u);
  });
});

describe("parseStaleCalls", () => {
  it("reads the class, time and version of each call", () => {
    const response = { result: { events: { events: [row("WorkspaceHost", 5)] } } };

    assert.deepEqual(parseStaleCalls(response), [
      { durableObject: "WorkspaceHost", atMs: 5, version: OLD_VERSION },
    ]);
  });

  it("skips rows without a script version, such as log lines", () => {
    const response = { result: { events: { events: [{ timestamp: 1, source: { event: "x" } }] } } };

    assert.deepEqual(parseStaleCalls(response), []);
  });
});

describe("versionFindings", () => {
  it("passes when no call after the grace ran an older version", () => {
    assert.deepEqual(versionFindings(input([])), []);
  });

  it("names the class, the older version and the span of its calls", () => {
    const [finding, ...rest] = versionFindings(
      input([stale("WorkspaceHost", 6), stale("WorkspaceHost", 9)]),
    );

    assert.equal(rest.length, 0);
    assert.equal(finding?.rule, "do-version-skew");
    assert.match(finding?.detail ?? "", /^WorkspaceHost ran d3670911 in 2 call\(s\)/u);
    assert.match(finding?.detail ?? "", /after the 2026-10-01T12:00Z deployment of 61f8dbef$/u);
  });

  it("reports each class on its own", () => {
    const findings = versionFindings(input([stale("Supervisor", 6), stale("WorkspaceHost", 7)]));

    assert.deepEqual(
      findings.map((finding) => finding.detail.split(" ")[0]),
      ["Supervisor", "WorkspaceHost"],
    );
  });

  it("reports an unavailable source instead of passing", () => {
    const unavailable: VersionInput = {
      worker: "cf-stumble",
      nowMs: DEPLOYED,
      state: { status: "unavailable", reason: "HTTP 403 from /deployments" },
    };

    assert.deepEqual(versionFindings(unavailable), [
      { rule: "unknown", detail: "HTTP 403 from /deployments", evidence: [] },
    ]);
  });
});
