import { afterEach, expect, test, vi, type MockInstance } from "vitest";
import {
  isTimeoutFailure,
  logEvent,
  logRedactedCause,
  timed,
  type LogFields,
} from "../src/diagnostics.js";

/**
 * `logRedactedCause` and `isTimeoutFailure` sit inside catch blocks whose whole job is to turn an
 * arbitrary thrown value into one generic, stable public result (ADR-0035). A cause is caller
 * input from the diagnostics module's point of view: it can be anything a dependency throws,
 * including a hostile object whose own `toString` or `message` getter throws. Rendering that
 * cause for the log must not itself throw, or the catch path these helpers serve fails instead of
 * returning its generic result.
 */

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

/**
 * `logEvent` is the one structured log line every operational event goes through, so an operator
 * can filter Workers Logs by `event` and by field instead of matching free text. Each call writes
 * exactly one plain object, at the console level its severity names, and every string field is
 * redacted and bounded before it leaves: a field is a name, a code, or an id, and a value that
 * turns out to carry a credential must not carry it into the log.
 */
function onlyEntry(spy: MockInstance<(...args: unknown[]) => void>): LogFields {
  expect(spy).toHaveBeenCalledTimes(1);
  const call = spy.mock.calls[0] ?? [];
  expect(
    call,
    "one log call is one argument, so Workers Logs indexes it as one event",
  ).toHaveLength(1);
  const [entry] = call;
  expect(entry).toBeTypeOf("object");

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: checked to be an object above, and `logEvent` writes only `LogFields`.
  return entry as LogFields;
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

test("a field cannot overwrite the event, level, or timestamp", () => {
  const logged = vi.spyOn(console, "log").mockImplementation(() => {});

  logEvent("info", "turn.settled", { event: "forged", level: "error", ts: "yesterday" });

  const entry = onlyEntry(logged);
  expect(entry.event).toBe("turn.settled");
  expect(entry.level).toBe("info");
  expect(entry.ts).not.toBe("yesterday");
});

test("a token inside a string field never reaches the log", () => {
  const token = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";
  const logged = vi.spyOn(console, "log").mockImplementation(() => {});

  logEvent("info", "github-credential.install", {
    detail: `remote: https://x:${token}@github.com/owner/repo failed ${token}`,
    source: "configured-token",
  });

  const written = JSON.stringify(onlyEntry(logged));
  expect(written).not.toContain(token);
  expect(written).toContain("configured-token");
});

test("a long string field is bounded", () => {
  const logged = vi.spyOn(console, "log").mockImplementation(() => {});

  logEvent("info", "route.refused", { route: "x".repeat(10_000) });

  expect(String(onlyEntry(logged).route).length).toBeLessThanOrEqual(200);
});

test("timed logs the outcome and duration of what it measured and returns its value", async () => {
  const logged = vi.spyOn(console, "log").mockImplementation(() => {});

  const value = await timed(
    "turn.mounted",
    { generation: 4 },
    () => Promise.resolve(7),
    (answer) => ({ outcome: answer === 7 ? "ok" : "wrong" }),
  );

  expect(value).toBe(7);
  const entry = onlyEntry(logged);
  expect(entry).toMatchObject({
    event: "turn.mounted",
    level: "info",
    generation: 4,
    outcome: "ok",
  });
  expect(entry.durationMs).toBeGreaterThanOrEqual(0);
});

test("timed logs a rejection at error level as `threw` and rethrows it unchanged", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const failure = new Error("the RPC went away");

  await expect(
    timed(
      "workspace.rpc",
      { method: "provision" },
      () => Promise.reject(failure),
      () => ({ outcome: "ok" }),
    ),
  ).rejects.toBe(failure);

  const entry = onlyEntry(error);
  expect(entry).toMatchObject({
    event: "workspace.rpc",
    level: "error",
    method: "provision",
    outcome: "threw",
  });
  expect(entry.durationMs).toBeGreaterThanOrEqual(0);
});
