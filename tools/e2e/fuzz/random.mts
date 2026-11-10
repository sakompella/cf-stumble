export class Random {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;

    let mixed = this.#state;

    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  }

  int(below: number): number {
    return Math.floor(this.next() * below);
  }

  between(low: number, high: number): number {
    return low + this.int(high - low + 1);
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];

    if (item === undefined) throw new Error("pick from an empty list");

    return item;
  }

  weighted<T>(entries: readonly (readonly [number, T])[]): T {
    const total = entries.reduce((sum, [weight]) => sum + weight, 0);

    let roll = this.next() * total;

    for (const [weight, value] of entries) {
      roll -= weight;

      if (roll < 0) return value;
    }

    return this.pick(entries)[1];
  }

  fork(): Random {
    return new Random(Math.floor(this.next() * 4294967296));
  }
}
