import type { LogFields } from "./diagnostics.js";

declare const requestIdBrand: unique symbol;

/**
 * Names one owner API request in the operational log, so the events it caused can be found with
 * one filter. The Worker generates it; no header, query, or body field can supply one.
 */
export type RequestId = string & { readonly [requestIdBrand]: never };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function newRequestId(): RequestId {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: a fresh UUID is the only value this brand admits besides `parseRequestId`.
  return crypto.randomUUID() as RequestId;
}

/**
 * Accept a request id that crossed an RPC boundary, or `undefined`. A caller that sends anything
 * else loses the correlation; it never loses the operation.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- RPC input is untrusted.
export function parseRequestId(value: unknown): RequestId | undefined {
  // SAFETY: the pattern proves the brand, so only a generated-looking UUID is asserted.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof, typescript/no-unsafe-type-assertion -- Boundary: the RPC payload is untrusted.
  return typeof value === "string" && UUID_PATTERN.test(value) ? (value as RequestId) : undefined;
}

/** The `requestId` log field, or no field when the call carries none. */
export function requestIdFields(requestId: RequestId | undefined): LogFields {
  return requestId === undefined ? {} : { requestId };
}
