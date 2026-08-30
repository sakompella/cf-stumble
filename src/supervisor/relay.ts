import type { ActiveGeneration } from "./generations.js";
import type { RelayFacts } from "./relay-facts.js";

export const RELAY_ATTEMPT_DEADLINE_MS = 5 * 60 * 1_000;

type RelayAttribution = {
  readonly active: ActiveGeneration;
  readonly preparationCheckId: number | undefined;
};

export class FacetRelay {
  private readonly facts: RelayFacts;

  constructor(facts: RelayFacts) {
    this.facts = facts;
  }

  async forward(
    request: Request,
    fetcher: Fetcher,
    attribution: RelayAttribution,
  ): Promise<Response> {
    const attempt = this.facts.start(
      attribution.active,
      attribution.preparationCheckId,
      Date.now(),
      RELAY_ATTEMPT_DEADLINE_MS,
    );
    request.signal.addEventListener(
      "abort",
      () => {
        this.facts.settle(attempt.id, "relay-cancelled", Date.now());
      },
      { once: true },
    );

    let upstream: Response;
    try {
      upstream = await fetcher.fetch(request);
    } catch {
      this.facts.settle(attempt.id, "pre-header-failure", Date.now());
      return new Response("Main facet failed before response headers", { status: 502 });
    }

    this.facts.headersReceived(attempt.id, upstream.status, Date.now());
    if (upstream.body === null) {
      this.facts.settle(attempt.id, "body-completed", Date.now());
      return responseWithBody(null, upstream);
    }

    const body: ReadableStream<unknown> = upstream.body;
    const reader = body.getReader();
    void reader.closed.catch(() => {});
    return responseWithBody(
      this.relayBody(reader, attempt.id, expectedBodyBytes(upstream.headers)),
      upstream,
    );
  }

  recordMountFailure(attribution: RelayAttribution): Response {
    const attempt = this.facts.start(
      attribution.active,
      attribution.preparationCheckId,
      Date.now(),
      RELAY_ATTEMPT_DEADLINE_MS,
    );
    this.facts.settle(attempt.id, "pre-header-failure", Date.now());
    return new Response("Cannot mount main facet", { status: 500 });
  }

  private relayBody(
    reader: ReadableStreamDefaultReader<unknown>,
    attemptId: number,
    expectedBytes: number | undefined,
  ): ReadableStream<Uint8Array> {
    const facts = this.facts;
    let bodyBytes = 0;
    const release = releaseOnce(reader);

    return new ReadableStream({
      pull(controller): Promise<void> {
        return reader.read().then(
          (result) => {
            if (result.done) {
              facts.settle(attemptId, bodyOutcome(expectedBytes, bodyBytes), Date.now());
              release();
              controller.close();
              return;
            }

            if (!(result.value instanceof Uint8Array)) {
              facts.settle(attemptId, "body-failed", Date.now());
              release();
              controller.error(new TypeError("main facet returned a non-byte stream chunk"));
              return;
            }

            bodyBytes += result.value.byteLength;
            controller.enqueue(result.value);
          },
          (error) => {
            facts.settle(attemptId, "body-failed", Date.now());
            release();
            controller.error(error);
          },
        );
      },
      cancel: (reason): Promise<void> => {
        facts.settle(attemptId, "relay-cancelled", Date.now());
        release();
        return reader.cancel(reason).then(
          () => {},
          () => {},
        );
      },
    });
  }
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
  expectedBytes: number | undefined,
  bodyBytes: number,
): "body-completed" | "body-failed" {
  return expectedBytes === undefined || expectedBytes === bodyBytes
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
