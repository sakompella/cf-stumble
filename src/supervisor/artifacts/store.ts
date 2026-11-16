import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { logRedactedCause } from "../../diagnostics.js";
import { parseMainHarnessArtifactJson } from "../../facet/index.js";
import type { MainHarnessArtifact } from "../../facet/index.js";
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

function moduleMapKey(harnessCommit: string): string {
  return `module-maps/${harnessCommit}.json`;
}

export class ModuleMapStore {
  private readonly bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.bucket = bucket;
  }

  read(harnessCommit: HarnessCommit): Effect.Effect<StoredModuleMap, StoredModuleMapProblem> {
    return Effect.tryPromise({
      try: async () => {
        const object = await this.bucket.get(moduleMapKey(harnessCommit));

        return object?.text();
      },
      catch: (cause) => {
        logRedactedCause(`artifact-store.read ${harnessCommit}: artifact-read-failed`, cause);

        return { code: "artifact-read-failed", harnessCommit } as const;
      },
    }).pipe(
      Effect.flatMap((text) =>
        text === undefined
          ? Effect.succeed({ kind: "absent" } as const)
          : decoded(text, harnessCommit),
      ),
    );
  }

  write(artifact: MainHarnessArtifact): Effect.Effect<MainHarnessArtifact, StoredModuleMapProblem> {
    return Effect.tryPromise({
      try: () =>
        this.bucket.put(moduleMapKey(artifact.harnessCommit), encodeModuleMap(artifact), {
          onlyIf: { etagDoesNotMatch: "*" },
        }),
      catch: (cause) => {
        logRedactedCause(
          `artifact-store.write ${artifact.harnessCommit}: artifact-write-failed`,
          cause,
        );

        return { code: "artifact-write-failed", harnessCommit: artifact.harnessCommit } as const;
      },
    }).pipe(
      Effect.flatMap((stored) =>
        stored === null ? this.existing(artifact.harnessCommit) : Effect.succeed(artifact),
      ),
    );
  }

  private existing(
    harnessCommit: HarnessCommit,
  ): Effect.Effect<MainHarnessArtifact, StoredModuleMapProblem> {
    return this.read(harnessCommit).pipe(
      Effect.flatMap((read) =>
        read.kind === "stored"
          ? Effect.succeed(read.artifact)
          : Effect.fail({ code: "artifact-write-failed", harnessCommit } as const),
      ),
    );
  }
}

function decoded(
  text: string,
  harnessCommit: HarnessCommit,
): Effect.Effect<StoredModuleMap, StoredModuleMapProblem> {
  const parsed = parseMainHarnessArtifactJson(text);

  if (Result.isFailure(parsed) || parsed.success.harnessCommit !== harnessCommit) {
    return Effect.fail({ code: "corrupt-artifact", harnessCommit });
  }

  return Effect.succeed({ kind: "stored", artifact: parsed.success });
}
