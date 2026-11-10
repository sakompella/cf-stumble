import { stopChildren } from "./process.mts";

export const MINUTE_MS = 60_000;

type Outcome = Readonly<{ name: string; ok: boolean; seconds: number; detail: string }>;

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

    console.error(`e2e: ${name} (limit ${limitMs / MINUTE_MS} min)`);

    try {
      await Promise.race([work(signal), aborted]);
    } catch (cause) {
      detail = describe(cause);
    }

    const seconds = Math.round((Date.now() - began) / 1000);

    this.#outcomes.push({ name, ok: detail === "", seconds, detail });
    console.error(`e2e: ${name} ${detail === "" ? "passed" : `failed: ${detail}`}`);

    return detail === "";
  }

  report(label: string): boolean {
    const passed = this.#outcomes.every((outcome) => outcome.ok);
    const minutes = Math.round((Date.now() - this.#startedMs) / MINUTE_MS);

    console.error(`\n${label}: ${passed ? "PASS" : "FAIL"} in ${minutes} min`);

    for (const { ok, name, seconds, detail } of this.#outcomes) {
      console.error(`${ok ? "✓" : "✗"} ${name} (${seconds} s)${ok ? "" : `: ${detail}`}`);
    }

    return passed;
  }
}
