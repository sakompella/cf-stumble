import { afterEach, expect, test, vi } from "vitest";
import { isTimeoutFailure, logRedactedCause } from "../src/diagnostics.js";

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
