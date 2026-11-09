import * as Result from "effect/Result";
import { logRedactedCause } from "../../diagnostics.js";
import { MainHarnessArtifact } from "../../facet/index.js";
import type { HarnessCommit } from "../../harness-commit.js";
import { encodeModuleMap } from "./module-map.js";

export type StoredModuleMapProblem =
  | { readonly code: "stored-module-map-absent"; readonly harnessCommit: string }
  | { readonly code: "corrupt-artifact"; readonly harnessCommit: string }
  | { readonly code: "artifact-read-failed"; readonly harnessCommit: string }
  | { readonly code: "artifact-write-failed"; readonly harnessCommit: string };

type StoredModuleMap =
  | Readonly<{ kind: "stored"; artifact: MainHarnessArtifact }>
  | Readonly<{ kind: "absent" }>;

type StoredModuleMapResult = Result.Result<StoredModuleMap, StoredModuleMapProblem>;

export function moduleMapKey(harnessCommit: string): string {
  return `module-maps/${harnessCommit}.json`;
}

export class ModuleMapStore {
  private readonly bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.bucket = bucket;
  }

  async read(harnessCommit: HarnessCommit): Promise<StoredModuleMapResult> {
    let text: string | undefined;

    try {
      const object = await this.bucket.get(moduleMapKey(harnessCommit));
      text = await object?.text();
    } catch (cause) {
      logRedactedCause(`artifact-store.read ${harnessCommit}: artifact-read-failed`, cause);

      return Result.fail({ code: "artifact-read-failed", harnessCommit });
    }

    return text === undefined ? Result.succeed({ kind: "absent" }) : decoded(text, harnessCommit);
  }

  async write(
    artifact: MainHarnessArtifact,
  ): Promise<Result.Result<MainHarnessArtifact, StoredModuleMapProblem>> {
    try {
      await this.bucket.put(moduleMapKey(artifact.harnessCommit), encodeModuleMap(artifact), {
        onlyIf: { etagDoesNotMatch: "*" },
      });
    } catch (cause) {
      logRedactedCause(
        `artifact-store.write ${artifact.harnessCommit}: artifact-write-failed`,
        cause,
      );

      return Result.fail({ code: "artifact-write-failed", harnessCommit: artifact.harnessCommit });
    }

    return Result.succeed(artifact);
  }
}

function decoded(text: string, harnessCommit: HarnessCommit): StoredModuleMapResult {
  const parsed = MainHarnessArtifact.parseJson(text);

  if (Result.isFailure(parsed) || parsed.success.harnessCommit !== harnessCommit) {
    return Result.fail({ code: "corrupt-artifact", harnessCommit });
  }

  return Result.succeed({ kind: "stored", artifact: parsed.success });
}
