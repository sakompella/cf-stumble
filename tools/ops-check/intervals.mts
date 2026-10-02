import { HOUR_MS, type AppEvent } from "./model.mts";

/** Half-open `[beginMs, endMs)` range. */
export interface Interval {
  readonly beginMs: number;
  readonly endMs: number;
}

export function overlapMs(a: Interval, b: Interval): number {
  return Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.beginMs, b.beginMs));
}

/** Sort and merge overlapping or touching intervals, so a bucket's coverage is not double-counted. */
export function mergeIntervals(intervals: readonly Interval[]): readonly Interval[] {
  const sorted = intervals.toSorted((a, b) => a.beginMs - b.beginMs);
  const merged: Interval[] = [];

  for (const next of sorted) {
    const last = merged.at(-1);

    if (last !== undefined && next.beginMs <= last.endMs) {
      merged[merged.length - 1] = {
        beginMs: last.beginMs,
        endMs: Math.max(last.endMs, next.endMs),
      };
    } else {
      merged.push(next);
    }
  }

  return merged;
}

/** True when any merged interval touches `bucket`, counting a zero-length interval as a point. */
export function touches(bucket: Interval, merged: readonly Interval[]): boolean {
  return merged.some(
    (interval) => interval.beginMs < bucket.endMs && interval.endMs >= bucket.beginMs,
  );
}

export function coveredMs(bucket: Interval, merged: readonly Interval[]): number {
  return merged.reduce((sum, interval) => sum + overlapMs(bucket, interval), 0);
}

/** The span an event's work covered: from its start to the moment it was logged. */
export function workSpan(event: AppEvent): Interval {
  return { beginMs: event.atMs - event.spanMs, endMs: event.atMs };
}

/** Items of a time series that fall inside `[atMs, atMs + HOUR_MS)`, for each start in turn. */
export function rollingHours<T extends { readonly atMs: number }>(
  items: readonly T[],
): readonly (readonly T[])[] {
  const sorted = items.toSorted((a, b) => a.atMs - b.atMs);

  return sorted.map((first) =>
    sorted.filter((item) => item.atMs >= first.atMs && item.atMs < first.atMs + HOUR_MS),
  );
}

/** The rolling hour holding the most items. Empty input answers an empty hour. */
export function busiestHour<T extends { readonly atMs: number }>(
  items: readonly T[],
): readonly T[] {
  return rollingHours(items).reduce<readonly T[]>(
    (best, hour) => (hour.length > best.length ? hour : best),
    [],
  );
}
