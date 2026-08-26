import { FILE_MODE, isSha, parseSha } from "./types.js";
import type { FileMode, GitObject, TreeEntry } from "./types.js";
import { concat, decodeUtf8, encodeUtf8 } from "./binary.js";

export function encodeTree(entries: readonly TreeEntry[]): Uint8Array {
  const encodedEntries = entries.map((entry) => encodeTreeEntry(entry));
  encodedEntries.sort((left, right) => compareBytes(left.sortKey, right.sortKey));
  validateTreeOrder(encodedEntries, "tree contains duplicate entry name");

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

  return concat(encodeUtf8(`tree ${body.byteLength}\0`, "object header"), body);
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
    encodeUtf8(`${mode} `, "tree entry mode"),
    concat(nameBytes, Uint8Array.of(0)),
  );
  const sortKey =
    mode === FILE_MODE.tree
      ? concat(nameBytes, Uint8Array.of(47))
      : nameBytes.slice();

  return { mode, name: entry.name, nameBytes, prefix, shaBytes, sortKey };
}

export function decodeTree(body: Uint8Array): Extract<GitObject, { type: "tree" }> {
  const entries: TreeEntry[] = [];
  const encodedEntries: EncodedTreeEntry[] = [];
  let offset = 0;

  while (offset < body.byteLength) {
    const decoded = decodeTreeEntry(body, offset);
    entries.push(decoded.entry);
    encodedEntries.push(decoded.encoded);
    offset = decoded.nextOffset;
  }

  validateTreeOrder(encodedEntries, "malformed git tree: duplicate entry name");
  for (let index = 1; index < encodedEntries.length; index += 1) {
    const previous = encodedEntries[index - 1];
    const current = encodedEntries[index];
    if (previous === undefined || current === undefined) {
      throw new Error("internal error: missing tree entry");
    }
    if (compareBytes(previous.sortKey, current.sortKey) > 0) {
      throw new Error("malformed git tree: entries are not sorted");
    }
  }

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

function validateTreeOrder(
  entries: readonly EncodedTreeEntry[],
  duplicateMessage: string,
): void {
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    if (previous === undefined || current === undefined) {
      throw new Error("internal error: missing tree entry");
    }
    if (compareBytes(previous.nameBytes, current.nameBytes) === 0) {
      throw new TypeError(`${duplicateMessage} ${JSON.stringify(current.name)}`);
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
  const bytes = encodeUtf8(name, "tree entry name");
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

function decodeSha(value: string): Uint8Array {
  const result = new Uint8Array(20);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
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
