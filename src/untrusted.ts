// oxlint-disable anti-slop/no-unsafe-dictionary-type -- An unvalidated JSON object has no representation narrower than `Record<string, unknown>`.

declare const untrustedBrand: unique symbol;

/** A value that reached a public boundary. Nothing may read it except through `field`. */
export type UntrustedObject = object & { readonly [untrustedBrand]: never };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// oxlint-disable-next-line anti-slop/no-object-parameters -- Boundary: accepts the narrowed object from a typeof guard.
export function asUntrusted(value: object): UntrustedObject {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: caller confirmed object and non-null.
  return value as UntrustedObject;
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- Boundary accessor: returns the raw value for the caller to narrow.
export function field(value: UntrustedObject, key: string): unknown {
  // SAFETY: any non-null object can be read by key, and the value read stays `unknown`.
  return (value as Record<string, unknown>)[key];
}

export function hasOwn(value: UntrustedObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** A request must carry exactly the fields it names, in any order, so an extra field is a rejection. */
export function hasExactKeys(
  value: UntrustedObject | Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);

  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
