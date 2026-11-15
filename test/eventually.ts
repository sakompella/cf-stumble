import { vi } from "vitest";

const PATIENCE = { timeout: 10_000, interval: 10 };

export function eventually<T>(check: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(check, PATIENCE);
}

export function eventuallyTruthy<T>(condition: () => T | Promise<T>) {
  return vi.waitUntil(condition, PATIENCE);
}

export function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
