/// <reference types="@cloudflare/workers-types" />

import { Result } from "better-result";
import { MainHarnessArtifact } from "../../facet/index.js";
import type { MainHarnessArtifactInput } from "../../facet/index.js";
import type { HarnessCommit } from "../../harness-commit.js";
import { canonicalModuleMap, encodeModuleMap } from "./module-map.js";

/**
 * The largest chunk of a stored module map. A Durable Object row, string, or BLOB may not exceed
 * 2 MB, and one generated module can be larger than that on its own, so neither the whole map nor
 * one module may occupy a row. The canonical encoding is split at this bound instead, which keeps
 * every row well under the platform limit whatever the harness compiles to.
 */
export const MODULE_MAP_CHUNK_BYTES = 1_048_576;

/**
 * The only storage operations a module-map store needs. `DurableObjectStorage` satisfies it. The
 * narrow shape is what lets a test drive the real transaction with a statement that fails.
 */
export type ModuleMapStorage = Readonly<{
  sql: Pick<SqlStorage, "exec">;
  transactionSync: <T>(operation: () => T) => T;
}>;

export type StoredModuleMapProblem =
  | { readonly code: "stored-module-map-absent"; readonly harnessCommit: string }
  | { readonly code: "stored-module-map-incomplete"; readonly harnessCommit: string }
  | { readonly code: "corrupt-artifact"; readonly harnessCommit: string }
  | { readonly code: "artifact-write-failed"; readonly harnessCommit: string };

/** A read either found a complete stored module map or found none. Neither answer builds. */
export type StoredModuleMap =
  | Readonly<{ kind: "stored"; moduleMap: MainHarnessArtifactInput }>
  | Readonly<{ kind: "absent" }>;

export type StoredModuleMapResult = Result<StoredModuleMap, StoredModuleMapProblem>;

type ManifestRow = { readonly chunk_count: number; readonly byte_count: number };

type ChunkRow = { readonly chunk_index: number; readonly bytes: ArrayBuffer };

/**
 * The Supervisor's module maps, in the Durable Object's own SQLite. A generation that is ready has
 * its map here, so activation and rollback load code that is already stored and never ask Computer
 * to build again. Nothing here decides which code may serve.
 */
export class ModuleMapStore {
  private readonly storage: ModuleMapStorage;

  constructor(storage: ModuleMapStorage) {
    this.storage = storage;
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS module_map_manifests (
        harness_commit TEXT PRIMARY KEY,
        chunk_count INTEGER NOT NULL CHECK (chunk_count > 0),
        byte_count INTEGER NOT NULL CHECK (byte_count > 0)
      );
      CREATE TABLE IF NOT EXISTS module_map_chunks (
        harness_commit TEXT NOT NULL,
        chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
        bytes BLOB NOT NULL,
        PRIMARY KEY (harness_commit, chunk_index)
      );
    `);
  }

  /**
   * Read the stored map for a labeled commit. The manifest's chunk count and byte count and the
   * contiguous chunk indexes are all checked, so a damaged row set is reported rather than
   * assembled: `MainHarnessArtifact.parse` accepts a map whose entry module is present even when
   * an imported module is missing, and that map would load as a broken generation.
   */
  read(harnessCommit: HarnessCommit): StoredModuleMapResult {
    const manifest = this.storage.sql
      .exec<ManifestRow>(
        "SELECT chunk_count, byte_count FROM module_map_manifests WHERE harness_commit = ?",
        harnessCommit,
      )
      .toArray()[0];

    if (manifest === undefined) {
      return Result.ok({ kind: "absent" });
    }

    const chunks = this.storage.sql
      .exec<ChunkRow>(
        "SELECT chunk_index, bytes FROM module_map_chunks WHERE harness_commit = ? ORDER BY chunk_index ASC",
        harnessCommit,
      )
      .toArray();

    const bytes = assembled(manifest, chunks);

    if (bytes === undefined) {
      return Result.err({ code: "stored-module-map-incomplete", harnessCommit });
    }

    return decoded(bytes, harnessCommit);
  }

  /**
   * Store a validated module map. The manifest and every chunk are written inside one
   * `transactionSync`, so a restart between two statements sees the map that was there before or
   * the whole new one, never a map missing a module.
   */
  write(artifact: MainHarnessArtifact): Result<MainHarnessArtifactInput, StoredModuleMapProblem> {
    const moduleMap = canonicalModuleMap(artifact);
    const bytes = new TextEncoder().encode(encodeModuleMap(moduleMap));
    const chunks = chunked(bytes);

    try {
      this.storage.transactionSync(() => {
        this.replace(artifact.harnessCommit, bytes.byteLength, chunks);
      });
    } catch {
      return Result.err({ code: "artifact-write-failed", harnessCommit: artifact.harnessCommit });
    }

    return Result.ok(moduleMap);
  }

  private replace(
    harnessCommit: HarnessCommit,
    byteCount: number,
    chunks: readonly Uint8Array[],
  ): void {
    this.storage.sql.exec("DELETE FROM module_map_chunks WHERE harness_commit = ?", harnessCommit);
    this.storage.sql.exec(
      `INSERT INTO module_map_manifests (harness_commit, chunk_count, byte_count)
       VALUES (?, ?, ?)
       ON CONFLICT (harness_commit) DO UPDATE SET chunk_count = excluded.chunk_count,
         byte_count = excluded.byte_count`,
      harnessCommit,
      chunks.length,
      byteCount,
    );

    for (const [index, chunk] of chunks.entries()) {
      this.storage.sql.exec(
        "INSERT INTO module_map_chunks (harness_commit, chunk_index, bytes) VALUES (?, ?, ?)",
        harnessCommit,
        index,
        chunk,
      );
    }
  }
}

function chunked(bytes: Uint8Array): readonly Uint8Array[] {
  const chunks: Uint8Array[] = [];

  for (let offset = 0; offset < bytes.byteLength; offset += MODULE_MAP_CHUNK_BYTES) {
    // `slice`, so each chunk is its own copy and a row holds no more than the bytes it names.
    chunks.push(bytes.slice(offset, offset + MODULE_MAP_CHUNK_BYTES));
  }

  return chunks;
}

/** The stored bytes, or nothing when the manifest and the chunk rows disagree. */
function assembled(manifest: ManifestRow, chunks: readonly ChunkRow[]): Uint8Array | undefined {
  if (chunks.length !== manifest.chunk_count) {
    return undefined;
  }

  const bytes = new Uint8Array(manifest.byte_count);
  let offset = 0;

  for (const [index, chunk] of chunks.entries()) {
    if (chunk.chunk_index !== index || offset + chunk.bytes.byteLength > manifest.byte_count) {
      return undefined;
    }

    bytes.set(new Uint8Array(chunk.bytes), offset);
    offset += chunk.bytes.byteLength;
  }

  return offset === manifest.byte_count ? bytes : undefined;
}

function decoded(bytes: Uint8Array, harnessCommit: HarnessCommit): StoredModuleMapResult {
  let value: unknown;

  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return Result.err({ code: "corrupt-artifact", harnessCommit });
  }

  const parsed = MainHarnessArtifact.parse(value);

  if (parsed.isErr() || parsed.value.harnessCommit !== harnessCommit) {
    return Result.err({ code: "corrupt-artifact", harnessCommit });
  }

  return Result.ok({ kind: "stored", moduleMap: canonicalModuleMap(parsed.value) });
}
