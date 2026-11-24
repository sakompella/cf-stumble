import { withSignal } from "./process.mts";

export const MINUTE_MS = 60_000;

type Outcome = Readonly<{ name: string; seconds: number }> &
  (
    | Readonly<{ status: "passed" }>
    | Readonly<{ status: "skipped"; reason: string }>
    | Readonly<{ status: "failed"; detail: string }>
  );

type Result =
  | Readonly<{ status: "passed" }>
  | Readonly<{ status: "skipped"; reason: string }>
  | Readonly<{ status: "failed"; detail: string }>;

export class Skip extends Error {}

function describe(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);

  const inner = cause.cause === undefined ? "" : describe(cause.cause);

  return cause.message.includes(inner) ? cause.message : `${cause.message} (${inner})`;
}

const MARK = { passed: "✓", skipped: "-", failed: "✗" } as const satisfies Record<
  Outcome["status"],
  string
>;

function note(result: Result): string {
  if (result.status === "passed") return "";

  return result.status === "skipped" ? result.reason : result.detail;
}

function wording(result: Result): string {
  return result.status === "passed" ? "passed" : `${result.status}: ${note(result)}`;
}

async function attempt(
  signal: AbortSignal,
  work: (signal: AbortSignal) => Promise<void>,
): Promise<Result> {
  if (signal.aborted) {
    return { status: "failed", detail: `not started: ${String(signal.reason)}` };
  }

  try {
    await withSignal(signal, () => work(signal));

    return { status: "passed" };
  } catch (cause) {
    if (cause instanceof Skip) return { status: "skipped", reason: describe(cause) };

    return {
      status: "failed",
      detail: signal.aborted ? `stopped: ${String(signal.reason)}` : describe(cause),
    };
  }
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
    process.on("SIGHUP", (signal) => {
      this.#onSignal(signal);
    });
  }

  #onSignal(signal: NodeJS.Signals): void {
    console.error(
      `e2e: ${signal}, ${this.#cleaning ? "cleanup continues" : "stopping, then cleaning up"}`,
    );

    if (this.#cleaning) return;

    this.#interrupted.abort(new Error(signal));
  }

  startCleanup(): void {
    this.#cleaning = true;
  }

  async run(
    name: string,
    limitMs: number,
    work: (signal: AbortSignal) => Promise<void>,
  ): Promise<boolean> {
    const began = Date.now();
    const limit = AbortSignal.timeout(limitMs);
    const signal = this.#cleaning ? limit : AbortSignal.any([this.#interrupted.signal, limit]);

    console.error(`e2e: ${name} (limit ${limitMs / MINUTE_MS} min)`);

    const result = await attempt(signal, work);

    const seconds = Math.round((Date.now() - began) / 1000);

    this.#outcomes.push({ name, seconds, ...result });
    console.error(`e2e: ${name} ${wording(result)}`);

    return result.status !== "failed";
  }

  report(label: string): boolean {
    const passed = this.#outcomes.every((outcome) => outcome.status !== "failed");
    const minutes = Math.round((Date.now() - this.#startedMs) / MINUTE_MS);

    console.error(`\n${label}: ${passed ? "PASS" : "FAIL"} in ${minutes} min`);

    for (const outcome of this.#outcomes) {
      console.error(
        `${MARK[outcome.status]} ${outcome.name} (${outcome.seconds} s)${note(outcome) === "" ? "" : `: ${note(outcome)}`}`,
      );
    }

    return passed;
  }
}
