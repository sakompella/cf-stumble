import {
  isJsonArray,
  isJsonNumber,
  isJsonRecord,
  isJsonString,
  parseJsonRecordText,
  type JsonRecord,
  type JsonValue,
} from "../json.mjs";

/** The one place a Chrome DevTools message is turned from text into typed data. */

/**
 * Walk a dotted path. A numeric step indexes an array, because DevTools puts the interesting part
 * of a console call in `args.0.value`. A step whose parent is neither a record nor an array ends
 * the walk at `undefined`: a missing field and a wrongly-typed one are the same fact to a caller,
 * which is that the browser did not say what was needed.
 */
function valueAtPath(root: JsonRecord, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = root;

  for (const step of path.split(".")) {
    if (current === undefined) {
      return undefined;
    }

    if (isJsonArray(current)) {
      const index = Math.trunc(Number(step));
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }

    if (!isJsonRecord(current)) {
      return undefined;
    }

    current = current[step];
  }

  return current;
}

/** One reply, read by name. */
export type CdpResult = Readonly<{
  value: (path: string) => JsonValue | undefined;
  text: (path: string) => string | undefined;
  count: (path: string) => number | undefined;
  json: () => string;
}>;

function cdpResult(raw: JsonRecord): CdpResult {
  const value = (path: string): JsonValue | undefined => valueAtPath(raw, path);

  return {
    value,
    text: (path) => {
      const found = value(path);

      return found !== undefined && isJsonString(found) ? found : undefined;
    },
    count: (path) => {
      const found = value(path);

      return found !== undefined && isJsonNumber(found) ? found : undefined;
    },
    json: () => JSON.stringify(raw),
  };
}

/** The same reader over a JSON document that arrived some other way (a DevTools HTTP endpoint). */
export function parseJsonRecord(text: string): CdpResult | undefined {
  const parsed = parseJsonRecordText(text);

  return parsed === undefined ? undefined : cdpResult(parsed);
}
