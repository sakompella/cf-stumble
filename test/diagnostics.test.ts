import * as Schema from "effect/Schema";
import { afterEach, expect, test, vi, type MockInstance } from "vitest";
import { logEvent, type LogFields } from "../src/diagnostics.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const decodeLogFields = Schema.decodeUnknownSync(
  Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]),
  ),
);

function onlyEntry(spy: MockInstance<(...args: unknown[]) => void>): LogFields {
  expect(spy).toHaveBeenCalledTimes(1);
  const call = spy.mock.calls[0] ?? [];
  expect(
    call,
    "one log call is one argument, so Workers Logs indexes it as one event",
  ).toHaveLength(1);
  const [entry] = call;

  return decodeLogFields(entry);
}

test("logEvent writes one JSON-safe object with the event, its level, a timestamp, and the fields", () => {
  const logged = vi.spyOn(console, "log").mockImplementation(() => {});

  logEvent("info", "turn.admitted", {
    projectId: "sample-project-one",
    count: 3,
    ok: true,
    lease: null,
  });

  const { ts, ...entry } = onlyEntry(logged);
  expect(entry).toEqual({
    event: "turn.admitted",
    level: "info",
    projectId: "sample-project-one",
    count: 3,
    ok: true,
    lease: null,
  });
  expect(Number.isNaN(Date.parse(String(ts))), "`ts` is an ISO timestamp").toBe(false);
  expect(JSON.parse(JSON.stringify(entry)), "the entry survives JSON unchanged").toEqual(entry);
});

test("logEvent writes each level to the console method of that severity", () => {
  const info = vi.spyOn(console, "log").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});

  logEvent("warn", "workspace.exclusion-wait", { result: "stale" });
  expect(onlyEntry(warn)).toMatchObject({ event: "workspace.exclusion-wait", level: "warn" });
  logEvent("error", "turn.lease-abandoned", { why: "start-threw" });
  expect(onlyEntry(error)).toMatchObject({ event: "turn.lease-abandoned", level: "error" });
  expect(info).not.toHaveBeenCalled();
});
