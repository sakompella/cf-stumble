declare const untrustedBrand: unique symbol;

/** A value that reached a public boundary. Nothing may read it except through `field`. */
export type UntrustedObject = object & { readonly [untrustedBrand]: never };

// oxlint-disable-next-line anti-slop/no-object-parameters -- Boundary: caller supplied RPC value after an object check.
export function asUntrusted(value: object): UntrustedObject {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: caller checked that value is a non-null object.
  return value as UntrustedObject;
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- Boundary accessor returns an unvalidated field for its caller to narrow.
export function field(value: UntrustedObject, key: string): unknown {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-unsafe-dictionary-type -- SAFETY: this is a branded untrusted object at the parsing boundary.
  return (value as Record<string, unknown>)[key];
}

/** A request must carry exactly the fields its kind names, so an extra field is a rejection. */
export function fieldsAreExactly(value: UntrustedObject, names: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === names.length && keys.every((key) => names.includes(key));
}
