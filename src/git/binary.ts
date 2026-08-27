import { Result } from "better-result";
import { GitObjectDecodeError } from "./errors.js";
import type { GitObjectDecodeLayer } from "./errors.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export function encodeUtf8(value: string, context: string): Uint8Array {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.codePointAt(index);
    if (codeUnit === undefined) {
      throw new TypeError(`invalid UTF-16 in ${context}`);
    }
    if (codeUnit > 0xffff) {
      index += 1;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdfff) {
      throw new TypeError(`invalid UTF-16 in ${context}`);
    }
  }
  return textEncoder.encode(value);
}

/**
 * Read bytes that arrived from outside as text. The decoder is strict (`fatal: true`), so this is
 * the one place in the codec where a byte string the caller did not produce can be rejected purely
 * for its encoding, which is why it reports which layer asked rather than throwing.
 */
export function decodeUtf8(
  bytes: Uint8Array,
  layer: GitObjectDecodeLayer,
  context: string,
): Result<string, GitObjectDecodeError> {
  try {
    return Result.ok(textDecoder.decode(bytes));
  } catch (error: unknown) {
    return Result.err(
      new GitObjectDecodeError({
        layer,
        condition: "invalid-utf8",
        detail: `invalid UTF-8 in ${context}`,
        cause: error,
      }),
    );
  }
}

export function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
  const result = new Uint8Array(first.byteLength + second.byteLength);
  result.set(first);
  result.set(second, first.byteLength);
  return result;
}

export function concatMany(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}
