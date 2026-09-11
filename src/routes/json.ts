// oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns -- Request JSON is parsed and validated at this HTTP boundary.

/**
 * Every owner API failure that is not a Supervisor decision uses one of these codes. The codes name
 * the fault in the request or the route, never the cause inside the Supervisor, so no internal
 * error text or credential can reach the client.
 */
export type ApiErrorCode =
  | "invalid-submission-request"
  | "invalid-activation-request"
  | "invalid-rollback-request"
  | "invalid-connect-request"
  | "invalid-turn-request"
  | "cross-origin-request"
  | "not-found"
  | "internal-error";

export function jsonError(status: number, code: ApiErrorCode): Response {
  return Response.json({ ok: false, error: { code } }, { status });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).toSorted();

  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

export function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
