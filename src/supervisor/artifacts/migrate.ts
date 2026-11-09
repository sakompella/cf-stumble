import type { HarnessCommit } from "../../harness-commit.js";
import { moduleMapKey } from "./store.js";

type ManifestRow = { readonly harness_commit: HarnessCommit; readonly byte_count: number };

type ChunkRow = { readonly bytes: ArrayBuffer };

export async function migrateModuleMaps(sql: SqlStorage, bucket: R2Bucket): Promise<void> {
  const present = sql
    .exec<{ readonly name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'module_map_manifests'",
    )
    .toArray();

  if (present.length === 0) return;

  const manifests = sql
    .exec<ManifestRow>("SELECT harness_commit, byte_count FROM module_map_manifests")
    .toArray();

  for (const manifest of manifests) {
    const bytes = new Uint8Array(manifest.byte_count);
    let offset = 0;

    for (const chunk of sql.exec<ChunkRow>(
      "SELECT bytes FROM module_map_chunks WHERE harness_commit = ? ORDER BY chunk_index ASC",
      manifest.harness_commit,
    )) {
      bytes.set(new Uint8Array(chunk.bytes), offset);
      offset += chunk.bytes.byteLength;
    }

    await bucket.put(moduleMapKey(manifest.harness_commit), bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
    });
  }

  sql.exec("DROP TABLE module_map_chunks");
  sql.exec("DROP TABLE module_map_manifests");
}
