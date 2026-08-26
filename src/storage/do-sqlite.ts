/// <reference types="@cloudflare/workers-types" />

import { parseSha } from "../git/types.js";
import type { Sha } from "../git/types.js";
import type { SweepableStore } from "./types.js";

const OBJECTS_TABLE = "cf_stumble_objects";
const POINTER_TABLE = "cf_stumble_pointer";

type ObjectRow = {
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

  constructor(state: DurableObjectState) {
    this.sql = state.storage.sql;
    state.storage.transactionSync(() => {
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS ${OBJECTS_TABLE} (sha TEXT PRIMARY KEY, bytes BLOB NOT NULL)`,
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
    return Promise.resolve(stored === undefined ? undefined : new Uint8Array(stored).slice());
  }

  async writeObject(bytes: Uint8Array): Promise<Sha> {
    const copy = new Uint8Array(bytes);
    const digest = await crypto.subtle.digest("SHA-1", copy);
    const sha = parseSha(bytesToHex(new Uint8Array(digest)));

    this.sql.exec(
      `INSERT OR IGNORE INTO ${OBJECTS_TABLE} (sha, bytes) VALUES (?, ?)`,
      sha,
      toArrayBuffer(copy),
    );
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
    this.sql.exec(`DELETE FROM ${OBJECTS_TABLE} WHERE sha = ?`, sha);
    return Promise.resolve();
  }
}
