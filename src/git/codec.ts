import {
  assertNever,
  FILE_MODE,
  isSha,
  parseSha,
} from "./types.js";
import type { FileMode, GitObject, TreeEntry } from "./types.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function encodeObject(object: GitObject): Uint8Array {
  switch (object.type) {
    case "blob":
      return encodeBlob(object.data);
    case "tree":
      return encodeTree(object.entries);
    case "commit":
      throw new Error(`${object.type} encoding is not implemented yet`);
    default:
      return assertNever(object, "git object encoding");
  }
}

export function decodeObject(bytes: Uint8Array): GitObject {
  const headerEnd = bytes.indexOf(0);
  if (headerEnd < 0) {
    throw new Error("malformed git object: missing header terminator");
  }

  const header = decodeUtf8(bytes.subarray(0, headerEnd), "object header");
  const match = /^(blob|tree|commit) ([0-9]+)$/u.exec(header);
  if (match === null) {
    throw new Error(`malformed git object header: ${JSON.stringify(header)}`);
  }

  const type = match[1];
  const lengthText = match[2];
  if (type === undefined || lengthText === undefined) {
    throw new TypeError("malformed git object header: missing type or length");
  }
  if (lengthText.length > 1 && lengthText.startsWith("0")) {
    throw new TypeError(
      `malformed git object header: non-canonical length ${lengthText}`,
    );
  }

  const length = Number(lengthText);
  if (!Number.isSafeInteger(length)) {
    throw new TypeError(`malformed git object header: invalid length ${lengthText}`);
  }

  const body = bytes.subarray(headerEnd + 1);
  if (body.byteLength !== length) {
    throw new Error(
      `malformed git object: header declares ${length} bytes, got ${body.byteLength}`,
    );
  }
  switch (type) {
    case "blob":
      return { type: "blob", data: body.slice() };
    case "tree":
      return decodeTree(body);
    case "commit":
      throw new Error(`${type} decoding is not implemented yet`);
    default:
      throw new Error(`malformed git object: unknown type ${JSON.stringify(type)}`);
  }
}

function encodeTree(entries: readonly TreeEntry[]): Uint8Array {
  const encodedEntries = entries.map((entry) => encodeTreeEntry(entry));
  encodedEntries.sort((left, right) => compareBytes(left.sortKey, right.sortKey));

  for (let index = 1; index < encodedEntries.length; index += 1) {
    const previous = encodedEntries[index - 1];
    const current = encodedEntries[index];
    if (previous === undefined || current === undefined) {
      throw new Error("internal error: missing tree entry");
    }
    if (compareBytes(previous.nameBytes, current.nameBytes) === 0) {
      throw new TypeError(`tree contains duplicate entry name ${JSON.stringify(current.name)}`);
    }
  }

  const bodyLength = encodedEntries.reduce(
    (length, entry) => length + entry.prefix.byteLength + entry.shaBytes.byteLength,
    0,
  );
  const body = new Uint8Array(bodyLength);
  let offset = 0;
  for (const entry of encodedEntries) {
    body.set(entry.prefix, offset);
    offset += entry.prefix.byteLength;
    body.set(entry.shaBytes, offset);
    offset += entry.shaBytes.byteLength;
  }

  return concat(textEncoder.encode(`tree ${body.byteLength}\0`), body);
}

type EncodedTreeEntry = {
  readonly mode: FileMode;
  readonly name: string;
  readonly nameBytes: Uint8Array;
  readonly prefix: Uint8Array;
  readonly shaBytes: Uint8Array;
  readonly sortKey: Uint8Array;
};

function encodeTreeEntry(entry: TreeEntry): EncodedTreeEntry {
  const mode = validateMode(entry.mode);
  const nameBytes = encodeTreeName(entry.name);
  if (!isSha(entry.sha)) {
    throw new TypeError(`invalid tree entry sha ${JSON.stringify(entry.sha)}`);
  }
  const shaBytes = decodeSha(entry.sha);
  const prefix = concat(
    textEncoder.encode(`${mode} `),
    concat(nameBytes, Uint8Array.of(0)),
  );
  const sortKey =
    mode === FILE_MODE.tree
      ? concat(nameBytes, Uint8Array.of(47))
      : nameBytes.slice();

  return { mode, name: entry.name, nameBytes, prefix, shaBytes, sortKey };
}

function decodeTree(body: Uint8Array): GitObject {
  const entries: TreeEntry[] = [];
  const encodedEntries: EncodedTreeEntry[] = [];
  let offset = 0;

  while (offset < body.byteLength) {
    const decoded = decodeTreeEntry(body, offset);
    entries.push(decoded.entry);
    encodedEntries.push(decoded.encoded);
    offset = decoded.nextOffset;
  }

  validateTreeOrder(encodedEntries);
  return { type: "tree", entries };
}

type DecodedTreeEntry = {
  readonly entry: TreeEntry;
  readonly encoded: EncodedTreeEntry;
  readonly nextOffset: number;
};

function decodeTreeEntry(body: Uint8Array, offset: number): DecodedTreeEntry {
  const modeEnd = body.indexOf(32, offset);
  if (modeEnd < 0) {
    throw new Error("malformed git tree: missing mode separator");
  }
  const mode = validateMode(
    decodeUtf8(body.subarray(offset, modeEnd), "tree mode"),
  );
  const nameStart = modeEnd + 1;
  const nameEnd = body.indexOf(0, nameStart);
  if (nameEnd < 0) {
    throw new Error("malformed git tree: missing entry name terminator");
  }
  const nameBytes = body.subarray(nameStart, nameEnd);
  const name = decodeTreeName(nameBytes);
  const shaStart = nameEnd + 1;
  const shaEnd = shaStart + 20;
  if (shaEnd > body.byteLength) {
    throw new Error("malformed git tree: entry has fewer than 20 sha bytes");
  }

  const shaBytes = body.slice(shaStart, shaEnd);
  const entry = { mode, name, sha: shaFromBytes(shaBytes) } satisfies TreeEntry;
  const encoded = {
    mode,
    name,
    nameBytes: nameBytes.slice(),
    prefix: body.slice(offset, shaStart),
    shaBytes,
    sortKey:
      mode === FILE_MODE.tree
        ? concat(nameBytes, Uint8Array.of(47))
        : nameBytes.slice(),
  } satisfies EncodedTreeEntry;
  return { entry, encoded, nextOffset: shaEnd };
}

function validateTreeOrder(entries: readonly EncodedTreeEntry[]): void {
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    if (previous === undefined || current === undefined) {
      throw new Error("internal error: missing tree entry");
    }
    const nameComparison = compareBytes(previous.nameBytes, current.nameBytes);
    if (nameComparison === 0) {
      throw new Error(`malformed git tree: duplicate entry name ${JSON.stringify(current.name)}`);
    }
    if (compareBytes(previous.sortKey, current.sortKey) > 0) {
      throw new Error("malformed git tree: entries are not sorted");
    }
  }
}

function validateMode(value: string): FileMode {
  switch (value) {
    case FILE_MODE.regular:
    case FILE_MODE.executable:
    case FILE_MODE.symlink:
    case FILE_MODE.tree:
      return value;
    default:
      throw new TypeError(`invalid git tree entry mode ${JSON.stringify(value)}`);
  }
}

function encodeTreeName(name: string): Uint8Array {
  const bytes = textEncoder.encode(name);
  validateTreeNameBytes(bytes, name);
  return bytes;
}

function decodeTreeName(bytes: Uint8Array): string {
  const name = decodeUtf8(bytes, "tree entry name");
  validateTreeNameBytes(bytes, name);
  return name;
}

function validateTreeNameBytes(bytes: Uint8Array, name: string): void {
  if (bytes.byteLength === 0) {
    throw new TypeError("git tree entry name must not be empty");
  }
  if (bytes.includes(0) || bytes.includes(47)) {
    throw new TypeError(`invalid git tree entry name ${JSON.stringify(name)}`);
  }
}

function decodeSha(bytes: string): Uint8Array {
  const result = new Uint8Array(20);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(bytes.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function shaFromBytes(bytes: Uint8Array): ReturnType<typeof parseSha> {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return parseSha(hex);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    const leftByte = left[index];
    const rightByte = right[index];
    if (leftByte === undefined || rightByte === undefined) {
      throw new Error("internal error: missing comparison byte");
    }
    if (leftByte !== rightByte) {
      return leftByte - rightByte;
    }
  }
  return left.byteLength - right.byteLength;
}

function encodeBlob(data: Uint8Array): Uint8Array {
  return concat(textEncoder.encode(`blob ${data.byteLength}\0`), data);
}

function decodeUtf8(bytes: Uint8Array, context: string): string {
  try {
    return textDecoder.decode(bytes);
  } catch (error: unknown) {
    throw new Error(`malformed git object ${context}: invalid UTF-8`, {
      cause: error,
    });
  }
}

function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
  const result = new Uint8Array(first.byteLength + second.byteLength);
  result.set(first);
  result.set(second, first.byteLength);
  return result;
}
