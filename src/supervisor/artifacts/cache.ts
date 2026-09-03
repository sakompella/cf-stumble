import { Result } from "better-result";
import { MainHarnessArtifact } from "../../facet/index.js";
import type { MainHarnessArtifactInput } from "../../facet/index.js";
import { parseHarnessCommit, type HarnessCommit } from "../../harness-commit.js";
import { canonicalModuleMap, encodeModuleMap } from "./module-map.js";

export type StoredModuleMapProblem =
  | { readonly code: "corrupt-artifact"; readonly harnessCommit: string }
  | { readonly code: "artifact-read-failed"; readonly harnessCommit: string }
  | { readonly code: "artifact-write-failed"; readonly harnessCommit: string }
  | { readonly code: "invalid-harness-commit"; readonly harnessCommit: string };

/** A cache read either found a valid module map or found nothing. */
export type CachedModuleMap =
  | Readonly<{ kind: "hit"; moduleMap: MainHarnessArtifactInput }>
  | Readonly<{ kind: "miss" }>;

export type CachedModuleMapResult = Result<CachedModuleMap, StoredModuleMapProblem>;

const MODULE_MAP_PREFIX = "module-maps/";

/**
 * The evictable R2 cache ADR-0034 describes. It holds derived build output keyed by the labeled
 * harness commit and nothing else, so a missing or corrupt object is a rebuild, never invalid
 * generation state. Nothing here decides which code may serve.
 */
export class ModuleMapCache {
  private readonly bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.bucket = bucket;
  }

  /** A corrupt object is a problem rather than a miss, and its caller rebuilds the commit. */
  async read(harnessCommit: HarnessCommit): Promise<CachedModuleMapResult> {
    let object: R2ObjectBody | null;
    try {
      object = await this.bucket.get(moduleMapKey(harnessCommit));
    } catch {
      return Result.err({ code: "artifact-read-failed", harnessCommit });
    }

    if (object === null) {
      return Result.ok({ kind: "miss" });
    }

    let value: MainHarnessArtifactInput;
    try {
      value = await object.json<MainHarnessArtifactInput>();
    } catch {
      return Result.err({ code: "corrupt-artifact", harnessCommit });
    }

    const parsed = MainHarnessArtifact.parse(value);
    if (parsed.isErr() || parsed.value.harnessCommit !== harnessCommit) {
      return Result.err({ code: "corrupt-artifact", harnessCommit });
    }

    return Result.ok({ kind: "hit", moduleMap: canonicalModuleMap(parsed.value) });
  }

  async write(
    moduleMap: MainHarnessArtifactInput,
  ): Promise<Result<MainHarnessArtifactInput, StoredModuleMapProblem>> {
    const harnessCommit = parseHarnessCommit(moduleMap.harnessCommit);
    if (harnessCommit === undefined) {
      return Result.err({
        code: "invalid-harness-commit",
        harnessCommit: moduleMap.harnessCommit,
      });
    }

    try {
      await this.bucket.put(moduleMapKey(harnessCommit), encodeModuleMap(moduleMap), {
        httpMetadata: { contentType: "application/json" },
      });
    } catch {
      return Result.err({ code: "artifact-write-failed", harnessCommit });
    }

    return Result.ok(moduleMap);
  }
}

function moduleMapKey(harnessCommit: HarnessCommit): string {
  return `${MODULE_MAP_PREFIX}${harnessCommit}`;
}
