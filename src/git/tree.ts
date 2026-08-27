import { Result, panic } from "better-result";
import { FILE_MODE, isSha, parseSha } from "./types.js";
import type { FileMode, GitObject, Sha, TreeEntry } from "./types.js";
import { GitObjectDecodeError } from "./errors.js";
import type { GitObjectDecodeCondition } from "./errors.js";
import { concat, decodeUtf8, encodeUtf8 } from "./binary.js";

type DecodedTree = Extract<GitObject, { type: "tree" }>;

export function encodeTree(entries: readonly TreeEntry[]): Uint8Array {
  const encodedEntries = entries.map((entry) => encodeTreeEntry(entry));
  encodedEntries.sort((left, right) => compareBytes(left.sortKey, right.sortKey));
  const duplicate = duplicateEntryName(encodedEntries);
  if (duplicate !== undefined) {
    throw new TypeError(`tree contains duplicate entry name ${JSON.stringify(duplicate)}`);
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
  const mode = encodeMode(entry.mode);
  const nameBytes = encodeTreeName(entry.name);
  if (!isSha(entry.sha)) {
    throw new TypeError(`invalid tree entry sha ${JSON.stringify(entry.sha)}`);
  }
  const shaBytes = decodeSha(entry.sha);
  const prefix = concat(
    encodeUtf8(`${mode} `, "tree entry mode"),
    concat(nameBytes, Uint8Array.of(0)),
  );

  return {
    mode,
    name: entry.name,
    nameBytes,
    prefix,
    shaBytes,
    sortKey: sortKeyOf(mode, nameBytes),
  };
}

export function decodeTree(body: Uint8Array): Result<DecodedTree, GitObjectDecodeError> {
  return Result.gen(function* () {
    const entries: TreeEntry[] = [];
    const encodedEntries: EncodedTreeEntry[] = [];
    let offset = 0;

    while (offset < body.byteLength) {
      const decoded = yield* decodeTreeEntry(body, offset);
      entries.push(decoded.entry);
      encodedEntries.push(decoded.encoded);
      offset = decoded.nextOffset;
    }

    const duplicate = duplicateEntryName(encodedEntries);
    if (duplicate !== undefined) {
      return Result.err(
        treeError("duplicate-entry-name", `duplicate entry name ${JSON.stringify(duplicate)}`),
      );
    }
    for (let index = 1; index < encodedEntries.length; index += 1) {
      if (
        compareBytes(sortKeyAt(encodedEntries, index - 1), sortKeyAt(encodedEntries, index)) > 0
      ) {
        return Result.err(treeError("unsorted-entries", "entries are not sorted"));
      }
    }

    const decoded = { type: "tree", entries } satisfies DecodedTree;
    return Result.ok<DecodedTree>(decoded);
  });
}

function treeError(condition: GitObjectDecodeCondition, detail: string): GitObjectDecodeError {
  return new GitObjectDecodeError({ layer: "tree", condition, detail });
}

type DecodedTreeEntry = {
  readonly entry: TreeEntry;
  readonly encoded: EncodedTreeEntry;
  readonly nextOffset: number;
};

function decodeTreeEntry(
  body: Uint8Array,
  offset: number,
): Result<DecodedTreeEntry, GitObjectDecodeError> {
  return Result.gen(function* () {
    const modeEnd = body.indexOf(32, offset);
    if (modeEnd < 0) {
      return Result.err(treeError("missing-mode-separator", "missing mode separator"));
    }
    const modeText = yield* decodeUtf8(body.subarray(offset, modeEnd), "tree", "entry mode");
    const mode = yield* decodeMode(modeText);

    const nameStart = modeEnd + 1;
    const nameEnd = body.indexOf(0, nameStart);
    if (nameEnd < 0) {
      return Result.err(treeError("missing-name-terminator", "missing entry name terminator"));
    }
    const nameBytes = body.subarray(nameStart, nameEnd);
    const name = yield* decodeTreeName(nameBytes);

    const shaStart = nameEnd + 1;
    const shaEnd = shaStart + 20;
    if (shaEnd > body.byteLength) {
      return Result.err(treeError("truncated-sha", "entry has fewer than 20 sha bytes"));
    }

    const shaBytes = body.slice(shaStart, shaEnd);
    const entry = { mode, name, sha: shaFromBytes(shaBytes) } satisfies TreeEntry;
    const encoded = {
      mode,
      name,
      nameBytes: nameBytes.slice(),
      prefix: body.slice(offset, shaStart),
      shaBytes,
      sortKey: sortKeyOf(mode, nameBytes),
    } satisfies EncodedTreeEntry;
    return Result.ok<DecodedTreeEntry>({ entry, encoded, nextOffset: shaEnd });
  });
}

/** Git sorts a directory as though its name ended in `/`, which is byte 47. */
function sortKeyOf(mode: FileMode, nameBytes: Uint8Array): Uint8Array {
  return mode === FILE_MODE.tree ? concat(nameBytes, Uint8Array.of(47)) : nameBytes.slice();
}

/** The name shared by two entries, or `undefined` when every name is distinct. */
function duplicateEntryName(entries: readonly EncodedTreeEntry[]): string | undefined {
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entryAt(entries, index - 1);
    const current = entryAt(entries, index);
    if (compareBytes(previous.nameBytes, current.nameBytes) === 0) {
      return current.name;
    }
  }
  return undefined;
}

function entryAt(entries: readonly EncodedTreeEntry[], index: number): EncodedTreeEntry {
  const entry = entries[index];
  if (entry === undefined) {
    panic(`tree entry ${index} is missing from a list of ${entries.length}`);
  }
  return entry;
}

function sortKeyAt(entries: readonly EncodedTreeEntry[], index: number): Uint8Array {
  return entryAt(entries, index).sortKey;
}

function isFileMode(value: string): value is FileMode {
  switch (value) {
    case FILE_MODE.regular:
    case FILE_MODE.executable:
    case FILE_MODE.symlink:
    case FILE_MODE.tree:
      return true;
    default:
      return false;
  }
}

function encodeMode(value: string): FileMode {
  if (!isFileMode(value)) {
    throw new TypeError(`invalid git tree entry mode ${JSON.stringify(value)}`);
  }
  return value;
}

function decodeMode(value: string): Result<FileMode, GitObjectDecodeError> {
  if (!isFileMode(value)) {
    return Result.err(treeError("invalid-mode", `invalid entry mode ${JSON.stringify(value)}`));
  }
  return Result.ok(value);
}

function encodeTreeName(name: string): Uint8Array {
  const bytes = encodeUtf8(name, "tree entry name");
  const rejection = treeNameRejection(bytes);
  if (rejection !== undefined) {
    throw new TypeError(`git tree entry name is invalid (${rejection}): ${JSON.stringify(name)}`);
  }
  return bytes;
}

function decodeTreeName(bytes: Uint8Array): Result<string, GitObjectDecodeError> {
  return Result.gen(function* () {
    const name = yield* decodeUtf8(bytes, "tree", "entry name");
    const rejection = treeNameRejection(bytes);
    if (rejection !== undefined) {
      return Result.err(
        treeError("invalid-name", `entry name is ${rejection}: ${JSON.stringify(name)}`),
      );
    }
    return Result.ok(name);
  });
}

/**
 * Why a tree entry name is unusable, or `undefined` when it is fine.
 *
 * This is narrower than git's own `verify_path`, which also refuses `.`, `..`, `.git` and its
 * NTFS/HFS aliases — a known open bug pinned by `test/git/oracle.props.test.ts` and recorded in
 * `docs/agents/design/review-findings.md`. Widening it changes which trees encode, so it is a
 * behavioural fix and belongs in its own change, not in this one.
 */
function treeNameRejection(bytes: Uint8Array): "empty" | "reserved-byte" | undefined {
  if (bytes.byteLength === 0) {
    return "empty";
  }
  if (bytes.includes(0) || bytes.includes(47)) {
    return "reserved-byte";
  }
  return undefined;
}

function decodeSha(value: string): Uint8Array {
  const result = new Uint8Array(20);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

/**
 * Twenty bytes always render as forty lowercase hex characters, so this is the trusted re-parse
 * `parseSha` documents rather than a boundary: a rejection here would mean `toString(16)` is
 * broken, not that the tree is malformed.
 */
function shaFromBytes(bytes: Uint8Array): Sha {
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
      panic(`byte ${index} is missing from a comparison of ${length} bytes`);
    }
    if (leftByte !== rightByte) {
      return leftByte - rightByte;
    }
  }
  return left.byteLength - right.byteLength;
}
