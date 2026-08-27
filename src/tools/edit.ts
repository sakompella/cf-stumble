import { Result, panic } from "better-result";
import {
  EditAmbiguousMatchError,
  EditNoMatchError,
  EmptyEditSearchError,
  type EditMatchError,
} from "./errors.js";

function countOccurrences(value: string, search: string): number {
  let count = 0;
  let offset = value.indexOf(search);
  while (offset >= 0) {
    count += 1;
    offset = value.indexOf(search, offset + 1);
  }
  return count;
}

/** Decide what a one-site edit would produce, without touching the workspace. */
export function prepareEdit(
  path: string,
  current: string,
  oldText: string,
  newText: string,
): Result<string, EditMatchError> {
  if (oldText.length === 0) {
    return Result.err(new EmptyEditSearchError({ path }));
  }

  const occurrences = countOccurrences(current, oldText);
  if (occurrences === 0) {
    return Result.err(new EditNoMatchError({ path, oldText }));
  }
  if (occurrences > 1) {
    return Result.err(new EditAmbiguousMatchError({ path, oldText, occurrences }));
  }

  const offset = current.indexOf(oldText);
  if (offset < 0) {
    panic(
      `counted edit match disappeared: countOccurrences found ${occurrences} match in ${JSON.stringify(path)} but indexOf found none`,
    );
  }
  return Result.ok(
    `${current.slice(0, offset)}${newText}${current.slice(offset + oldText.length)}`,
  );
}
