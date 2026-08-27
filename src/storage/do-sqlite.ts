/// <reference types="@cloudflare/workers-types" />

import { parseSha } from "../git/types.js";
import type { Sha } from "../git/types.js";
import type { SweepableStore } from "./types.js";

const OBJECTS_TABLE = "cf_stumble_objects";
const CHUNKS_TABLE = "cf_stumble_object_chunks";
const POINTER_TABLE = "cf_stumble_pointer";
const CHUNK_SIZE = 512 * 1024;
const MAX_OBJECT_BYTES = 10 * 1024 * 1024 * 1024;

export interface ObjectTooLargeError extends Error {
  readonly actualBytes: number;
  readonly code: "OBJECT_TOO_LARGE";
  readonly maxBytes: number;
}

function makeObjectTooLargeError(actualBytes: number, maxBytes: number): ObjectTooLargeError {
  const error = new Error(`object is ${actualBytes} bytes, but the maximum is ${maxBytes} bytes`);
  error.name = "ObjectTooLargeError";
  const code: ObjectTooLargeError["code"] = "OBJECT_TOO_LARGE";
  return Object.assign(error, { actualBytes, code, maxBytes });
}

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

  readObject(sha: Sha): Promise<Uint8Array | undefined> {
    const rows = this.sql
      .exec<ObjectRow>(`SELECT bytes FROM ${OBJECTS_TABLE} WHERE sha = ?`, sha)
      .toArray();
    const stored = rows[0]?.bytes;
    if (stored === undefined) {
      return Promise.resolve(stored);
    }

    const chunks = this.sql
      .exec<ChunkRow>(
        `SELECT chunk_index, bytes FROM ${CHUNKS_TABLE} WHERE sha = ? ORDER BY chunk_index`,
        sha,
      )
      .toArray();
    if (chunks.length === 0) {
      return Promise.resolve(new Uint8Array(stored).slice());
    }

    let totalBytes = 0;
    for (const chunk of chunks) {
      totalBytes += chunk.bytes.byteLength;
    }
    const output = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      const chunkBytes = new Uint8Array(chunk.bytes);
      output.set(chunkBytes, offset);
      offset += chunkBytes.byteLength;
    }
    return Promise.resolve(output);
  }

  async writeObject(bytes: Uint8Array): Promise<Sha> {
    const copy = bytes.slice();
    if (copy.byteLength > MAX_OBJECT_BYTES) {
      throw makeObjectTooLargeError(copy.byteLength, MAX_OBJECT_BYTES);
    }
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
    return sha;
  }

  readPointer(): Promise<Sha | undefined> {
    const rows = this.sql
      .exec<PointerRow>(`SELECT sha FROM ${POINTER_TABLE} WHERE id = 1`)
      .toArray();
    const sha = rows[0]?.sha;
    return Promise.resolve(sha === null || sha === undefined ? undefined : parseSha(sha));
  }

  setPointer(next: Sha, expected: Sha | undefined): Promise<boolean> {
    const result =
      expected === undefined
        ? this.sql.exec(`UPDATE ${POINTER_TABLE} SET sha = ? WHERE id = 1 AND sha IS NULL`, next)
        : this.sql.exec(
            `UPDATE ${POINTER_TABLE} SET sha = ? WHERE id = 1 AND sha = ?`,
            next,
            expected,
          );
    return Promise.resolve(result.rowsWritten === 1);
  }

  listObjects(): Promise<readonly Sha[]> {
    const rows = this.sql.exec<ShaRow>(`SELECT sha FROM ${OBJECTS_TABLE} ORDER BY sha`).toArray();
    return Promise.resolve(rows.map((row) => parseSha(row.sha)));
  }

  deleteObject(sha: Sha): Promise<void> {
    this.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM ${CHUNKS_TABLE} WHERE sha = ?`, sha);
      this.sql.exec(`DELETE FROM ${OBJECTS_TABLE} WHERE sha = ?`, sha);
    });
    return Promise.resolve();
  }
}
