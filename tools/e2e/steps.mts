import { stopChildren } from "./process.mts";

export const MINUTE_MS = 60_000;

type Outcome = Readonly<{
  name: string;
  ok: boolean;
  skipped: boolean;
  seconds: number;
  detail: string;
}>;

export class Skip extends Error {}

function describe(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);

  const inner = cause.cause === undefined ? "" : describe(cause.cause);

  return cause.message.includes(inner) ? cause.message : `${cause.message} (${inner})`;
}

export class Steps {
  readonly #outcomes: Outcome[] = [];
  readonly #interrupted = new AbortController();
  readonly #startedMs = Date.now();
  #cleaning = false;

  constructor() {
    process.on("SIGINT", (signal) => {
      this.#onSignal(signal);
    });
    process.on("SIGTERM", (signal) => {
      this.#onSignal(signal);
    });
  }

  #onSignal(signal: NodeJS.Signals): void {
    console.error(
      `e2e: ${signal}, ${this.#cleaning ? "cleanup continues" : "stopping, then cleaning up"}`,
    );

    if (this.#cleaning) return;

    this.#interrupted.abort(new Error(signal));
    stopChildren();
  }

  startCleanup(): void {
    this.#cleaning = true;
  }

  get interrupted(): AbortSignal {
    return this.#interrupted.signal;
  }

  async run(
    name: string,
    limitMs: number,
    work: (signal: AbortSignal) => Promise<void>,
  ): Promise<boolean> {
    const began = Date.now();
    const limit = AbortSignal.timeout(limitMs);
    const signal = this.#cleaning ? limit : AbortSignal.any([this.#interrupted.signal, limit]);

    const aborted = new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(new Error(`stopped: ${String(signal.reason)}`));
      });
    });

    let detail = "";
    let skipped = false;

    console.error(`e2e: ${name} (limit ${limitMs / MINUTE_MS} min)`);

    try {
      await Promise.race([work(signal), aborted]);
    } catch (cause) {
      detail = describe(cause);
      skipped = cause instanceof Skip;
    }

    const seconds = Math.round((Date.now() - began) / 1000);
    const ok = skipped || detail === "";

    this.#outcomes.push({ name, ok, skipped, seconds, detail });
    console.error(
      `e2e: ${name} ${skipped ? `skipped: ${detail}` : ok ? "passed" : `failed: ${detail}`}`,
    );

    return ok;
  }

  report(label: string): boolean {
    const passed = this.#outcomes.every((outcome) => outcome.ok);
    const minutes = Math.round((Date.now() - this.#startedMs) / MINUTE_MS);

    console.error(`\n${label}: ${passed ? "PASS" : "FAIL"} in ${minutes} min`);

    for (const { ok, skipped, name, seconds, detail } of this.#outcomes) {
      const mark = skipped ? "-" : ok ? "✓" : "✗";

      console.error(`${mark} ${name} (${seconds} s)${detail === "" ? "" : `: ${detail}`}`);
    }

    return passed;
  }
}
