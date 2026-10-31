import type { Context } from "@earendil-works/chord/context";
import {
  FileError,
  LineScanner,
  type BinaryReader,
  type FileInfo,
  type LineScan,
  type Result,
} from "@earendil-works/pi-durable/env";
import { aborted, invalid, type ComputerWorkspace } from "./execution-env-paths.js";
import { fileInfoOf, open, readBytes, statFollowing } from "./execution-env-files.js";

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
