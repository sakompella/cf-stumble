import { asUntrusted, field, fieldsAreExactly } from "../untrusted.js";

/** Parse the optional turn budget without letting untrusted data enter the capability. */
export function parseProjectBudget(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Durable Object RPC input is untrusted.
  value: unknown,
): number | undefined {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: budget input is untrusted.
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const request = asUntrusted(value);

  if (!fieldsAreExactly(request, ["remainingMs"])) return undefined;

  const remainingMs = field(request, "remainingMs");

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: remainingMs is untrusted.
  return typeof remainingMs === "number" && Number.isFinite(remainingMs) && remainingMs > 0
    ? remainingMs
    : undefined;
}
