export type Rng = Readonly<{
  next: () => number;
  int: (below: number) => number;
  between: (low: number, high: number) => number;
  chance: (probability: number) => boolean;
  pick: <T>(items: readonly T[]) => T;
  weighted: <T>(entries: readonly (readonly [T, number])[]) => T;
  hex: (length: number) => string;
}>;

export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;

    let mixed = Math.imul(state ^ (state >>> 15), state | 1);

    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };

  const int = (below: number): number => Math.floor(next() * below);

  const pick = <T,>(items: readonly T[]): T => {
    const item = items[int(items.length)];

    if (item === undefined) throw new Error("pick from an empty list");

    return item;
  };

  return {
    next,
    int,
    between: (low, high) => low + int(high - low + 1),
    chance: (probability) => next() < probability,
    pick,
    weighted: (entries) => {
      const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
      let at = next() * total;

      for (const [value, weight] of entries) {
        at -= weight;

        if (at < 0) return value;
      }

      return pick(entries)[0];
    },
    hex: (length) => Array.from({ length }, () => int(16).toString(16)).join(""),
  };
}
