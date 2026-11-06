import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JsonRecord, JsonValue } from "../json.mts";
import { parseInvocations, parseModelCalls, parseSessionFailures, parseUsage } from "./fetch.mts";

const MEMORY_BYTES = 8 * 1024 ** 3;

const usageResponse = (groups: readonly JsonRecord[]): JsonValue => ({
  data: { viewer: { accounts: [{ containersUsageAdaptiveGroups: groups }] } },
});

const group = (bucket: string, allocatedMemory: number): JsonRecord => ({
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
    const invocation: JsonRecord = {
      timestamp: 2,
      $workers: { wallTimeMs: 5, event: { request: { url: "https://x.test/api/status" } } },
    };

    const logLine: JsonRecord = {
      timestamp: 1,
      source: { event: "workspace.backend.connected" },
      $workers: { event: { request: { url: "http://computer.internal/api" } } },
    };

    const parsed = parseInvocations({ result: { events: { events: [logLine, invocation] } } });

    assert.deepEqual(parsed, [{ endMs: 2, wallTimeMs: 5, route: "/api/status" }]);
  });

  it("refuses a response at its row limit, which may be cut off", () => {
    const row: JsonRecord = {
      timestamp: 1,
      $workers: { wallTimeMs: 1, event: { request: { url: "https://x.test/health" } } },
    };

    const events = Array.from({ length: 2000 }, () => row);

    assert.throws(() => parseInvocations({ result: { events: { events } } }), /most it gives/u);
  });
});

describe("parseSessionFailures", () => {
  it("keeps only session-failed events, with their cause", () => {
    const failed: JsonRecord = {
      timestamp: 3,
      source: { event: "facet.session-failed", cause: "storage reset" },
    };

    const other: JsonRecord = { timestamp: 4, source: { event: "run.settled" } };

    const parsed = parseSessionFailures({ result: { events: { events: [other, failed] } } });

    assert.deepEqual(parsed, [{ atMs: 3, cause: "storage reset" }]);
  });
});

describe("parseModelCalls", () => {
  it("keeps model.call events with their prompt and cached tokens", () => {
    const call: JsonRecord = {
      timestamp: 3,
      source: { event: "model.call", promptTokens: 100, cachedTokens: 80 },
    };

    const other: JsonRecord = { timestamp: 4, source: { event: "run.settled" } };

    assert.deepEqual(parseModelCalls({ result: { events: { events: [other, call] } } }), {
      calls: [{ promptTokens: 100, cachedTokens: 80 }],
      sample: false,
    });
  });

  it("marks a full page as a sample instead of failing", () => {
    const call: JsonRecord = {
      timestamp: 3,
      source: { event: "model.call", promptTokens: 100, cachedTokens: 80 },
    };

    const page = Array.from({ length: 2000 }, () => call);

    assert.equal(parseModelCalls({ result: { events: { events: page } } }).sample, true);
  });
});
