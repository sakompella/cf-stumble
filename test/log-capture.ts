import { vi, type MockInstance } from "vitest";
import type { LogFields } from "../src/diagnostics.js";

export type LoggedEvent = LogFields & Readonly<{ event?: string; outcome?: string }>;

export function capturedEvents(): () => LoggedEvent[] {
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

function isLogFields(value: unknown): value is LoggedEvent {
  return typeof value === "object" && value !== null;
}

export function named(events: readonly LoggedEvent[], event: string): LoggedEvent[] {
  return events.filter((entry) => entry.event === event);
}

function isText(value: unknown): value is string {
  return typeof value === "string";
}

export function textLines(spy: MockInstance<(...args: unknown[]) => void>): string[] {
  return spy.mock.calls.filter(([first]) => isText(first)).map((call) => call.join(" "));
}

export function everythingLogged(): string {
  return (["log", "warn", "error"] as const)
    .map((level) => JSON.stringify(vi.spyOn(console, level).mock.calls))
    .join("\n");
}
