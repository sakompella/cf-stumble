export class IdleLeases {
  readonly #held = new Set<Readonly<{ endsAtMs: number }>>();

  add(endsAtMs: number): () => boolean {
    const lease = { endsAtMs };
    this.#held.add(lease);

    return () => this.#held.delete(lease);
  }

  expire(nowMs: number): number | null {
    let latestEndMs: number | null = null;

    for (const lease of this.#held) {
      if (lease.endsAtMs > nowMs) continue;

      this.#held.delete(lease);
      latestEndMs = Math.max(latestEndMs ?? lease.endsAtMs, lease.endsAtMs);
    }

    return latestEndMs;
  }

  latestEndMs(): number | null {
    let latest: number | null = null;

    for (const lease of this.#held) latest = Math.max(latest ?? lease.endsAtMs, lease.endsAtMs);

    return latest;
  }
}
