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

export function decodeUtf8(bytes: Uint8Array, context: string): string {
  try {
    return textDecoder.decode(bytes);
  } catch (error: unknown) {
    throw new Error(`malformed git object ${context}: invalid UTF-8`, {
      cause: error,
    });
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
