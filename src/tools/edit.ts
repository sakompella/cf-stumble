export type EditMatchError =
  | { readonly kind: "empty-search"; readonly path: string }
  | { readonly kind: "no-match"; readonly path: string; readonly oldText: string }
  | {
      readonly kind: "ambiguous-match";
      readonly path: string;
      readonly oldText: string;
      readonly occurrences: number;
    };

export type EditDecision =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly error: EditMatchError };

function countOccurrences(value: string, search: string): number {
  let count = 0;
  let offset = value.indexOf(search);
  while (offset >= 0) {
    count += 1;
    offset = value.indexOf(search, offset + 1);
  }
  return count;
}

export function prepareEdit(
  path: string,
  current: string,
  oldText: string,
  newText: string,
): EditDecision {
  if (oldText.length === 0) {
    return { ok: false, error: { kind: "empty-search", path } };
  }

  const occurrences = countOccurrences(current, oldText);
  if (occurrences === 0) {
    return { ok: false, error: { kind: "no-match", path, oldText } };
  }
  if (occurrences > 1) {
    return { ok: false, error: { kind: "ambiguous-match", path, oldText, occurrences } };
  }

  const offset = current.indexOf(oldText);
  if (offset < 0) {
    throw new Error("internal error: counted edit match disappeared");
  }
  return {
    ok: true,
    content: `${current.slice(0, offset)}${newText}${current.slice(offset + oldText.length)}`,
  };
}
