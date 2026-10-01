import { tracing } from "cloudflare:workers";

/** The part of the runtime `tracing` object this module uses, so a test can supply a fake. */
export type SpanTracer = Readonly<{
  enterSpan: <T>(name: string, callback: (span: SpanAttributes) => T) => T;
}>;

type SpanAttributes = Readonly<{
  setAttributes: (attributes: Record<string, string>) => void;
}>;

type Captured<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: unknown }>;

const SPAN_NAME = "owner-api.route";

/**
 * Run `work` inside an `owner-api.route` span that carries the request id and the route pattern,
 * so a trace can be found from a `route.settled` event. The runtime has no call that reads the
 * active span, so this opens a child span of the handler's span.
 *
 * Tracing must never change a request. If the tracing API is missing or throws before it calls
 * `work`, `work` runs unspanned. If it throws after, the outcome `work` already produced is
 * returned or thrown unchanged. `work` runs exactly once either way.
 */
export function withRouteSpan<T>(
  attributes: Readonly<{ requestId: string; route: string }>,
  work: () => T,
  tracer: SpanTracer = tracing,
): T {
  let captured: Captured<T> | undefined;

  try {
    return tracer.enterSpan(SPAN_NAME, (span) => {
      setSpanAttributes(span, attributes);

      try {
        const value = work();
        captured = { ok: true, value };

        return value;
      } catch (error) {
        captured = { ok: false, error };

        throw error;
      }
    });
  } catch {
    if (captured === undefined) return work();

    if (captured.ok) return captured.value;

    throw captured.error;
  }
}

function setSpanAttributes(
  span: SpanAttributes,
  attributes: Readonly<{ requestId: string; route: string }>,
): void {
  try {
    span.setAttributes({ "request.id": attributes.requestId, route: attributes.route });
  } catch {
    // A span that rejects attributes still times the request.
  }
}
