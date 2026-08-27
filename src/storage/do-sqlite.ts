/// <reference types="@cloudflare/workers-types" />

import { panic, Result } from "better-result";
import { parseSha } from "../git/types.js";
import type { Sha } from "../git/types.js";
import { StorageCapacityError, StorageUnavailableError, type StorageOperation } from "./errors.js";
import { MAX_OBJECT_BYTES, ObjectTooLargeError, type SweepableStore } from "./types.js";

// Keep the existing object table as the one-row-per-object index. New rows use an empty
// marker in its legacy `bytes` column, while old rows with no chunk rows remain readable.
const OBJECTS_TABLE = "cf_stumble_objects";
const CHUNKS_TABLE = "cf_stumble_object_chunks";
const POINTER_TABLE = "cf_stumble_pointer";
// 512 KiB leaves four times the documented 2 MiB row limit for SQLite values and metadata.
const CHUNK_SIZE = 512 * 1024;
const MISSING_OBJECT: Uint8Array | undefined = undefined;
type ObjectRow = {
  readonly bytes: ArrayBuffer;
};

type ChunkRow = {
  readonly chunk_index: number;
  readonly bytes: ArrayBuffer;
};

type PointerRow = {
  readonly sha: string | null;
};

type ShaRow = {
  readonly sha: string;
};

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function storageUnavailable(operation: StorageOperation, cause: unknown): StorageUnavailableError {
  return new StorageUnavailableError({ operation, cause });
}

function writeStorageError(
  operation: StorageOperation,
  cause: unknown,
): StorageCapacityError | StorageUnavailableError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.includes("SQLITE_FULL")
    ? new StorageCapacityError({ operation, cause })
    : storageUnavailable(operation, cause);
}

function assertSingleRow(rows: readonly unknown[], description: string): void {
  if (rows.length > 1) {
    panic(`SQLite storage has duplicate ${description} rows`);
  }
}

function validateChunks(stored: ArrayBuffer, chunks: readonly ChunkRow[], sha: Sha): void {
  if (chunks.length === 0) {
    return;
  }
  if (stored.byteLength !== 0) {
    panic(`SQLite object ${sha} has chunks and a legacy inline representation`);
  }
  for (const [index, chunk] of chunks.entries()) {
    if (!Number.isSafeInteger(chunk.chunk_index) || chunk.chunk_index !== index) {
      panic(`SQLite object ${sha} has non-contiguous chunk indexes`);
    }
    const isLast = index === chunks.length - 1;
    if (chunk.bytes.byteLength === 0 || chunk.bytes.byteLength > CHUNK_SIZE) {
      panic(`SQLite object ${sha} has an invalid chunk length`);
    }
    if (!isLast && chunk.bytes.byteLength !== CHUNK_SIZE) {
      panic(`SQLite object ${sha} has a short non-final chunk`);
    }
  }
}

export class DurableObjectSqliteStore implements SweepableStore {
  private readonly sql: SqlStorage;
  private readonly storage: DurableObjectState["storage"];

  constructor(state: DurableObjectState) {
    this.sql = state.storage.sql;
    this.storage = state.storage;
    this.storage.transactionSync(() => {
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS ${OBJECTS_TABLE} (sha TEXT PRIMARY KEY, bytes BLOB NOT NULL)`,
      );
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS ${CHUNKS_TABLE} (sha TEXT NOT NULL, chunk_index INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (sha, chunk_index))`,
      );
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS ${POINTER_TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), sha TEXT)`,
      );
      this.sql.exec(`INSERT OR IGNORE INTO ${POINTER_TABLE} (id, sha) VALUES (1, NULL)`);
    });
  }

  readObject(sha: Sha): ReturnType<SweepableStore["readObject"]> {
    let rows: ObjectRow[];
    try {
      rows = this.sql
        .exec<ObjectRow>(`SELECT bytes FROM ${OBJECTS_TABLE} WHERE sha = ?`, sha)
        .toArray();
    } catch (cause: unknown) {
      return Promise.resolve(Result.err(storageUnavailable("readObject", cause)));
    }
    assertSingleRow(rows, `object ${sha}`);
    const stored = rows[0]?.bytes;
    if (stored === undefined) {
      return Promise.resolve(Result.ok(MISSING_OBJECT));
    }

    let chunks: ChunkRow[];
    try {
      chunks = this.sql
        .exec<ChunkRow>(
          `SELECT chunk_index, bytes FROM ${CHUNKS_TABLE} WHERE sha = ? ORDER BY chunk_index`,
          sha,
        )
        .toArray();
    } catch (cause: unknown) {
      return Promise.resolve(Result.err(storageUnavailable("readObject", cause)));
    }
    validateChunks(stored, chunks, sha);

    try {
      if (chunks.length === 0) {
        return Promise.resolve(Result.ok(new Uint8Array(stored).slice()));
      }
      const totalBytes = chunks.reduce((total, chunk) => total + chunk.bytes.byteLength, 0);
      const output = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        const chunkBytes = new Uint8Array(chunk.bytes);
        output.set(chunkBytes, offset);
        offset += chunkBytes.byteLength;
      }
      return Promise.resolve(Result.ok(output));
    } catch (cause: unknown) {
      return Promise.resolve(Result.err(storageUnavailable("readObject", cause)));
    }
  }

  async writeObject(bytes: Uint8Array): ReturnType<SweepableStore["writeObject"]> {
    if (bytes.byteLength > MAX_OBJECT_BYTES) {
      return Result.err(
        new ObjectTooLargeError({ actualBytes: bytes.byteLength, maxBytes: MAX_OBJECT_BYTES }),
      );
    }
    try {
      const copy = bytes.slice();
      const digest = await crypto.subtle.digest("SHA-1", copy);
      const sha = parseSha(bytesToHex(new Uint8Array(digest)));

      this.storage.transactionSync(() => {
        const result = this.sql.exec(
          `INSERT OR IGNORE INTO ${OBJECTS_TABLE} (sha, bytes) VALUES (?, ?)`,
          sha,
          toArrayBuffer(new Uint8Array()),
        );
        if (result.rowsWritten === 0) {
          return;
        }

        let chunkIndex = 0;
        for (let offset = 0; offset < copy.byteLength; offset += CHUNK_SIZE) {
          const end = Math.min(offset + CHUNK_SIZE, copy.byteLength);
          this.sql.exec(
            `INSERT INTO ${CHUNKS_TABLE} (sha, chunk_index, bytes) VALUES (?, ?, ?)`,
            sha,
            chunkIndex,
            toArrayBuffer(copy.slice(offset, end)),
          );
          chunkIndex += 1;
        }
      });
      return Result.ok(sha);
    } catch (cause: unknown) {
      return Result.err(writeStorageError("writeObject", cause));
    }
  }

  readPointer(): ReturnType<SweepableStore["readPointer"]> {
    let rows: PointerRow[];
    try {
      rows = this.sql.exec<PointerRow>(`SELECT sha FROM ${POINTER_TABLE} WHERE id = 1`).toArray();
    } catch (cause: unknown) {
      return Promise.resolve(Result.err(storageUnavailable("readPointer", cause)));
    }
    if (rows.length !== 1) {
      panic("SQLite storage is missing or has duplicate pointer singleton rows");
    }
    const row = rows[0];
    if (row === undefined) {
      return panic("SQLite storage is missing pointer singleton row");
    }
    const sha = row.sha;
    return Promise.resolve(Result.ok(sha === null ? undefined : parseSha(sha)));
  }

  setPointer(next: Sha, expected: Sha | undefined): ReturnType<SweepableStore["setPointer"]> {
    try {
      const result =
        expected === undefined
          ? this.sql.exec(`UPDATE ${POINTER_TABLE} SET sha = ? WHERE id = 1 AND sha IS NULL`, next)
          : this.sql.exec(
              `UPDATE ${POINTER_TABLE} SET sha = ? WHERE id = 1 AND sha = ?`,
              next,
              expected,
            );
      return Promise.resolve(Result.ok(result.rowsWritten === 1));
    } catch (cause: unknown) {
      return Promise.resolve(Result.err(writeStorageError("setPointer", cause)));
    }
  }

  listObjects(): ReturnType<SweepableStore["listObjects"]> {
    let rows: ShaRow[];
    try {
      rows = this.sql.exec<ShaRow>(`SELECT sha FROM ${OBJECTS_TABLE} ORDER BY sha`).toArray();
    } catch (cause: unknown) {
      return Promise.resolve(Result.err(storageUnavailable("listObjects", cause)));
    }
    return Promise.resolve(Result.ok(rows.map((row) => parseSha(row.sha))));
  }

  deleteObject(sha: Sha): ReturnType<SweepableStore["deleteObject"]> {
    try {
      this.storage.transactionSync(() => {
        this.sql.exec(`DELETE FROM ${CHUNKS_TABLE} WHERE sha = ?`, sha);
        this.sql.exec(`DELETE FROM ${OBJECTS_TABLE} WHERE sha = ?`, sha);
      });
      return Promise.resolve(Result.ok());
    } catch (cause: unknown) {
      return Promise.resolve(Result.err(storageUnavailable("deleteObject", cause)));
    }
  }
}
