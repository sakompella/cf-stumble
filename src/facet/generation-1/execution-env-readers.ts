import type { Context } from "@earendil-works/chord/context";
import {
  FileError,
  LineScanner,
  type BinaryReader,
  type DirReader,
  type FileInfo,
  type LineScan,
  type Result,
  type TextLine,
  type TextLineReader,
} from "@earendil-works/pi-durable/env";
import {
  aborted,
  invalid,
  type ComputerWorkspace,
  type WorkspacePath,
} from "./execution-env-paths.js";
import {
  fileInfoOf,
  listDirectory,
  open,
  readBytes,
  statFollowing,
} from "./execution-env-files.js";

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

class SnapshotBinaryReader implements BinaryReader {
  readonly #bytes: Uint8Array;
  readonly #info: FileInfo;
  #closed = false;

  constructor(bytes: Uint8Array, info: FileInfo) {
    this.#bytes = bytes;
    this.#info = info;
  }

  info(context: Context): Promise<Result<FileInfo, FileError>> {
    return Promise.resolve(this.#usable(context) ?? { ok: true, value: this.#info });
  }

  read(offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>> {
    const refused = this.#usable(context);

    if (refused !== undefined) return Promise.resolve(refused);

    if (!isCount(offset) || !isCount(length)) {
      return Promise.resolve(
        invalid("Offset and length must be non-negative safe integers", this.#info.path),
      );
    }

    return Promise.resolve({ ok: true, value: this.#bytes.slice(offset, offset + length) });
  }

  scanLines(
    options: { startLine: number; endLine?: number },
    context: Context,
  ): Promise<Result<LineScan, FileError>> {
    const refused = this.#usable(context);

    if (refused !== undefined) return Promise.resolve(refused);

    const { startLine, endLine } = options;

    const validEnd =
      endLine === undefined || (Number.isSafeInteger(endLine) && endLine > startLine);

    if (!isCount(startLine) || !validEnd) {
      return Promise.resolve(invalid("Invalid line range", this.#info.path));
    }

    const scanner = new LineScanner(startLine, endLine);
    scanner.push(this.#bytes);

    return Promise.resolve({ ok: true, value: scanner.finish() });
  }

  close(_context: Context): Promise<void> {
    this.#closed = true;

    return Promise.resolve();
  }

  #usable(context: Context): Result<never, FileError> | undefined {
    if (context.abortSignal?.aborted === true) return aborted(this.#info.path);

    return this.#closed ? invalid("Binary reader is closed", this.#info.path) : undefined;
  }
}

export async function openBinaryReader(
  workspace: ComputerWorkspace,
  path: string,
  noFollow: boolean,
  context: Context,
): Promise<Result<BinaryReader, FileError>> {
  const opened = open(workspace, path, context);

  if (!opened.ok) return opened;

  const { absolute } = opened.value;
  const stat = await statFollowing(workspace, opened.value);

  if (!stat.ok) return stat;

  if (noFollow && stat.value.linked) return invalid("Refusing to follow a symbolic link", absolute);

  if (stat.value.info.kind === "directory") {
    return { ok: false, error: new FileError("is_directory", "Is a directory", absolute) };
  }

  const bytes = await readBytes(workspace, stat.value.canonical.absolute, context);

  if (!bytes.ok) return bytes;

  const info = { ...fileInfoOf(opened.value, stat.value.info), size: bytes.value.byteLength };

  return { ok: true, value: new SnapshotBinaryReader(bytes.value, info) };
}

function textLinesOf(bytes: Uint8Array): TextLine[] {
  const parts = new TextDecoder().decode(bytes).split("\n");
  const last = parts.pop() ?? "";
  const lines = parts.map((text) => ({ text, terminated: true }));

  return last === "" ? lines : [...lines, { text: last, terminated: false }];
}

class SnapshotTextLineReader implements TextLineReader {
  readonly #lines: TextLine[];
  readonly #path: string;
  #closed = false;

  constructor(lines: TextLine[], path: string) {
    this.#lines = lines;
    this.#path = path;
  }

  readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
    if (context.abortSignal?.aborted === true) return Promise.resolve(aborted(this.#path));

    if (this.#closed) return Promise.resolve(invalid("Text line reader is closed", this.#path));

    return Promise.resolve({ ok: true, value: this.#lines.shift() });
  }

  close(_context: Context): Promise<void> {
    this.#closed = true;

    return Promise.resolve();
  }
}

export async function openTextLineReader(
  workspace: ComputerWorkspace,
  path: string,
  context: Context,
): Promise<Result<TextLineReader, FileError>> {
  const bytes = await readBytes(workspace, path, context);

  if (!bytes.ok) return bytes;

  return { ok: true, value: new SnapshotTextLineReader(textLinesOf(bytes.value), path) };
}

class ListingDirReader implements DirReader {
  readonly #workspace: ComputerWorkspace;
  readonly #directory: WorkspacePath;
  readonly #pending: string[];
  #closed = false;

  constructor(workspace: ComputerWorkspace, directory: WorkspacePath, names: string[]) {
    this.#workspace = workspace;
    this.#directory = directory;
    this.#pending = names;
  }

  async next(
    maxEntries: number,
    context: Context,
  ): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
    if (context.abortSignal?.aborted === true) return aborted(this.#directory.absolute);

    if (this.#closed) return invalid("Directory reader is closed", this.#directory.absolute);

    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      return invalid("maxEntries must be a positive safe integer", this.#directory.absolute);
    }

    if (this.#pending.length === 0) return { ok: true, value: { entries: [], done: true } };

    const listed = await listDirectory(this.#workspace, this.#directory);

    if (!listed.ok) return listed;

    const current = new Map(listed.value.map((entry) => [entry.name, entry]));
    const entries: FileInfo[] = [];

    while (entries.length < maxEntries && this.#pending.length > 0) {
      const entry = current.get(this.#pending.shift() ?? "");

      if (entry !== undefined) entries.push(entry);
    }

    return { ok: true, value: { entries, done: this.#pending.length === 0 } };
  }

  close(_context: Context): Promise<void> {
    this.#closed = true;

    return Promise.resolve();
  }
}

export async function openDirReader(
  workspace: ComputerWorkspace,
  path: string,
  context: Context,
): Promise<Result<DirReader, FileError>> {
  const opened = open(workspace, path, context);

  if (!opened.ok) return opened;

  const listed = await listDirectory(workspace, opened.value);

  if (!listed.ok) return listed;

  const names = listed.value.map((entry) => entry.name);

  return { ok: true, value: new ListingDirReader(workspace, opened.value, names) };
}

export async function readTextLines(
  workspace: ComputerWorkspace,
  path: string,
  maxLines: number | undefined,
  context: Context,
): Promise<Result<string[], FileError>> {
  if (maxLines !== undefined && maxLines <= 0) return { ok: true, value: [] };

  const bytes = await readBytes(workspace, path, context);

  if (!bytes.ok) return bytes;

  return {
    ok: true,
    value: textLinesOf(bytes.value)
      .slice(0, maxLines)
      .map((line) => line.text),
  };
}
