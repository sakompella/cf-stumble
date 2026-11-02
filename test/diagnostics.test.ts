import * as Schema from "effect/Schema";
import { afterEach, expect, test, vi, type MockInstance } from "vitest";
import {
  isTimeoutFailure,
  logEvent,
  logRedactedCause,
  type LogFields,
} from "../src/diagnostics.js";
import { textLines } from "./log-capture.js";
import { syntheticJwt } from "./synthetic-jwt.js";

afterEach(() => {
  vi.restoreAllMocks();
});

test("logs a fixed fallback instead of throwing when a cause's toString throws", () => {
  const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => {});

  const hostileCause = {
    toString(): string {
      throw new Error("toString refuses to run");
    },
  };

  expect(() => {
    logRedactedCause("workspace.harness-build.thread: workspace-unavailable", hostileCause);
  }).not.toThrow();

  expect(loggedErrors).toHaveBeenCalledTimes(1);
  const logged = loggedErrors.mock.calls[0]?.join(" ") ?? "";
  expect(logged).toContain("workspace.harness-build.thread: workspace-unavailable");
  expect(logged).toContain("[unprintable cause]");
});

test("logs a fixed fallback instead of throwing when a cause's message getter throws", () => {
  const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => {});
  const hostileCause = new Error("placeholder");
  Object.defineProperty(hostileCause, "message", {
    get(): string {
      throw new Error("message getter refuses to run");
    },
  });

  expect(() => {
    logRedactedCause("workspace.provision-project.clone: workspace-unavailable", hostileCause);
  }).not.toThrow();

  expect(loggedErrors).toHaveBeenCalledTimes(1);
  const logged = loggedErrors.mock.calls[0]?.join(" ") ?? "";
  expect(logged).toContain("[unprintable cause]");
});

test("logRedactedCause redacts every segment of a short JWT and keeps the surrounding text", () => {
  const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => {});
  const jwt = syntheticJwt();

  logRedactedCause(
    "example.step: unavailable",
    new Error(`JWKS unavailable for ${jwt.token} after retry`),
  );

  const [logged = ""] = textLines(loggedErrors);
  expect(logged).toContain("example.step: unavailable");
  expect(logged).toContain("JWKS unavailable for [redacted] after retry");

  for (const segment of jwt.segments) expect(logged).not.toContain(segment);
});

test("logRedactedCause redacts a JWT that crosses the cause length limit", () => {
  const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => {});
  const jwt = syntheticJwt(600);
  expect(jwt.token.length, "the token alone is longer than the logged cause").toBeGreaterThan(400);

  logRedactedCause("example.step: unavailable", new Error(`${"context ".repeat(40)}${jwt.token}`));

  const [logged = ""] = textLines(loggedErrors);
  expect(logged).toContain("context context");

  for (const segment of jwt.segments) expect(logged).not.toContain(segment);
});

test("isTimeoutFailure reports false instead of throwing when a cause's message getter throws", () => {
  const hostileCause = new Error("placeholder");
  Object.defineProperty(hostileCause, "message", {
    get(): string {
      throw new Error("message getter refuses to run");
    },
  });

  expect(() => isTimeoutFailure(hostileCause)).not.toThrow();
  expect(isTimeoutFailure(hostileCause)).toBe(false);
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
