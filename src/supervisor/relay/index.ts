import type { MainFacetMountProblem } from "../artifacts/index.js";
import type { ActiveGeneration } from "../generations/index.js";
import type { RelayAttempts } from "./attempts.js";

export const RELAY_ATTEMPT_DEADLINE_MS = 5 * 60 * 1_000;

type RelayAttribution = {
  readonly active: ActiveGeneration;
  readonly preparationCheckId: number | undefined;
};

type BodyTermination =
  | { readonly kind: "clean" }
  | { readonly error: unknown; readonly kind: "failed" };

export class FacetRelay {
  private readonly attempts: RelayAttempts;

  constructor(attempts: RelayAttempts) {
    this.attempts = attempts;
  }

  async forward(
    request: Request,
    fetcher: Pick<Fetcher, "fetch">,
    attribution: RelayAttribution,
  ): Promise<Response> {
    const attempt = this.attempts.start(
      attribution.active,
      attribution.preparationCheckId,
      Date.now(),
      RELAY_ATTEMPT_DEADLINE_MS,
    );
    request.signal.addEventListener(
      "abort",
      () => {
        this.attempts.settle(attempt.id, "relay-cancelled", Date.now());
      },
      { once: true },
    );

    let upstream: Response;
    try {
      upstream = await fetcher.fetch(request);
    } catch {
      this.attempts.settle(attempt.id, "pre-header-failure", Date.now());
      return new Response("Main facet failed before response headers", { status: 502 });
    }

    this.attempts.headersReceived(attempt.id, upstream.status);
    if (upstream.body === null) {
      this.attempts.settle(attempt.id, "body-completed", Date.now());
      return responseWithBody(null, upstream);
    }

    const body: ReadableStream<unknown> = upstream.body;
    const reader = body.getReader();
    return responseWithBody(
      this.relayBody(reader, attempt.id, expectedBodyBytes(upstream.headers)),
      upstream,
    );
  }

  /**
   * A mount failure with no active generation is not a fault: the Supervisor holds no built-in
   * code, so there is nothing to serve until the owner submits a harness commit and activates the
   * generation the Supervisor labels. It records no attempt, because ADR-0031 derives eligibility
   * from attempts and an attempt attributed to no generation is evidence about none. Every other
   * failure belongs to the active generation and is recorded against it.
   */
  recordMountFailure(problem: MainFacetMountProblem, attribution: RelayAttribution): Response {
    if (problem.code === "no-active-generation") {
      return Response.json({ ok: false, problem: { code: problem.code } }, { status: 503 });
    }

    const attempt = this.attempts.start(
      attribution.active,
      attribution.preparationCheckId,
      Date.now(),
      RELAY_ATTEMPT_DEADLINE_MS,
    );
    this.attempts.settle(attempt.id, "pre-header-failure", Date.now());
    return new Response("Cannot mount main facet", { status: 500 });
  }

  private relayBody(
    reader: ReadableStreamDefaultReader<unknown>,
    attemptId: number,
    expectedBytes: number | undefined,
  ): ReadableStream<Uint8Array> {
    const state = { bodyBytes: 0 };
    const release = releaseOnce(reader);
    const termination = reader.closed.then(
      () => ({ kind: "clean" as const }),
      (error) => ({
        error: error instanceof Error ? error : new Error(String(error)),
        kind: "failed" as const,
      }),
    );

    return new ReadableStream({
      pull: (controller) =>
        pullRelayBody(
          reader,
          controller,
          termination,
          this.attempts,
          attemptId,
          expectedBytes,
          state,
          release,
        ),
      cancel: (reason): Promise<void> => {
        this.attempts.settle(attemptId, "relay-cancelled", Date.now());
        release();
        return reader.cancel(reason).then(
          () => {},
          () => {},
        );
      },
    });
  }
}

function pullRelayBody(
  reader: ReadableStreamDefaultReader<unknown>,
  controller: ReadableStreamDefaultController<Uint8Array>,
  termination: Promise<BodyTermination>,
  attempts: RelayAttempts,
  attemptId: number,
  expectedBytes: number | undefined,
  state: { bodyBytes: number },
  release: () => void,
): Promise<void> {
  return reader.read().then(
    async (result) => {
      if (result.done) {
        await finishRelayBody(
          controller,
          termination,
          attempts,
          attemptId,
          expectedBytes,
          state.bodyBytes,
          release,
        );
      } else if (result.value instanceof Uint8Array) {
        state.bodyBytes += result.value.byteLength;
        controller.enqueue(result.value);
      } else {
        attempts.settle(
          attemptId,
          bodyOutcome("failed", expectedBytes, state.bodyBytes),
          Date.now(),
        );
        release();
        controller.error(new TypeError("main facet returned a non-byte stream chunk"));
      }
    },
    (error) => {
      attempts.settle(attemptId, bodyOutcome("failed", expectedBytes, state.bodyBytes), Date.now());
      release();
      controller.error(error);
    },
  );
}

function finishRelayBody(
  controller: ReadableStreamDefaultController<Uint8Array>,
  termination: Promise<BodyTermination>,
  attempts: RelayAttempts,
  attemptId: number,
  expectedBytes: number | undefined,
  bodyBytes: number,
  release: () => void,
): Promise<void> {
  return termination.then((result) => {
    attempts.settle(attemptId, bodyOutcome(result.kind, expectedBytes, bodyBytes), Date.now());
    release();
    if (result.kind === "failed") {
      controller.error(result.error);
      return;
    }

    controller.close();
  });
}

function releaseOnce(reader: ReadableStreamDefaultReader<unknown>): () => void {
  let released = false;
  return () => {
    if (!released) {
      released = true;
      reader.releaseLock();
    }
  };
}

function bodyOutcome(
  termination: BodyTermination["kind"],
  expectedBytes: number | undefined,
  bodyBytes: number,
): "body-completed" | "body-failed" {
  return termination === "clean" && (expectedBytes === undefined || expectedBytes === bodyBytes)
    ? "body-completed"
    : "body-failed";
}

function expectedBodyBytes(headers: Headers): number | undefined {
  const value = headers.get("content-length");
  return value !== null && /^\d+$/u.test(value) ? Number(value) : undefined;
}

function responseWithBody(body: BodyInit | null, upstream: Response): Response {
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

export { RelayAttempts } from "./attempts.js";
export type { RelayAttempt, RelayAttribution, RelayOutcome, TurnTerminal } from "./attempt.js";
