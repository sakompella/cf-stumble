import { vi } from "vitest";
import type { LogFields } from "../src/diagnostics.js";

/**
 * Capture the structured events `logEvent` writes, at every level, without printing them. Plain
 * text lines from `logRedactedCause` are dropped: a test of an event reads the event.
 *
 * Call it before the code under test runs, and read the events after; `vi.restoreAllMocks` in the
 * test's `afterEach` removes the spies.
 */
export function capturedEvents(): () => LogFields[] {
  const spies = [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
  ];

  return () =>
    spies.flatMap((spy) =>
      spy.mock.calls.flatMap((call: readonly unknown[]) =>
        call.filter((argument) => isLogFields(argument)),
      ),
    );
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- A console argument can be anything; this guard is what proves it is an event.
function isLogFields(value: unknown): value is LogFields {
  return typeof value === "object" && value !== null;
}

/** The events of one name, in the order they were written at their level. */
export function named(events: readonly LogFields[], event: string): LogFields[] {
  return events.filter((entry) => entry.event === event);
}
