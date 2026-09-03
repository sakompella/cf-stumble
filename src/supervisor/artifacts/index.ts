import { Result } from "better-result";
import {
  fixtureMainHarnessArtifact,
  loadMainFacet,
  MainHarnessArtifact,
} from "../../facet/index.js";
import type {
  MainFacetCapabilities,
  MainHarnessArtifactInput,
  MainHarnessArtifactProblem,
} from "../../facet/index.js";
import { parseHarnessCommit, type HarnessCommit } from "../../harness-commit.js";
import { mainFacetName } from "./facet-name.js";
import type { ActiveGeneration } from "../generations/index.js";

type StoredArtifactProblem =
  | {
      readonly code: "corrupt-artifact";
      readonly harnessCommit: string;
    }
  | {
      readonly code: "artifact-read-failed" | "artifact-write-failed";
      readonly harnessCommit: string;
    };

export type HarnessArtifactProblem =
  | MainHarnessArtifactProblem
  | StoredArtifactProblem
  | { readonly code: "retained-artifact-mismatch"; readonly harnessCommit: string };

export type HarnessArtifactResult = Result<
  {
    readonly artifact: MainHarnessArtifactInput;
    readonly effect: "retained" | "verified" | "rebuilt";
  },
  HarnessArtifactProblem
>;

export type RetainedHarnessArtifactResult = Result<
  MainHarnessArtifactInput | void,
  HarnessArtifactProblem
>;

const MODULE_MAP_PREFIX = "module-maps/";

/** R2 is an evictable cache. Durable Object SQLite stores no module source. */
export class HarnessArtifacts {
  private readonly bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.bucket = bucket;
  }

  async retain(input: MainHarnessArtifactInput): Promise<HarnessArtifactResult> {
    const parsed = MainHarnessArtifact.parse(input);
    if (parsed.isErr()) {
      return Result.err(parsed.error);
    }

    const canonicalInput = artifactInput(parsed.value);
    const retained = await this.get(parsed.value.harnessCommit);
    if (retained.isErr()) {
      if (retained.error.code !== "corrupt-artifact") {
        return Result.err(retained.error);
      }

      return this.write(canonicalInput, "rebuilt");
    }

    if (retained.value !== undefined) {
      return sameArtifact(retained.value, canonicalInput)
        ? Result.ok({ artifact: retained.value, effect: "verified" })
        : Result.err({
            code: "retained-artifact-mismatch",
            harnessCommit: parsed.value.harnessCommit,
          });
    }

    return this.write(canonicalInput, "retained");
  }

  async mount(
    active: ActiveGeneration,
    loader: WorkerLoader,
    facets: DurableObjectState["facets"],
    modelRoute: MainFacetCapabilities["MODEL"],
  ): Promise<Result<{ readonly fetcher: Fetcher }, string>> {
    const retained =
      active.generation === undefined
        ? await this.retain(fixtureMainHarnessArtifact)
        : await this.get(active.generation.harnessCommit);
    if (retained.isErr()) {
      return Result.err(retained.error.code);
    }

    if (retained.value === undefined) {
      return Result.err("retained artifact was not found");
    }

    const artifact = "artifact" in retained.value ? retained.value.artifact : retained.value;
    const loadedFacet = loadMainFacet(loader, artifact, { MODEL: modelRoute });
    if (loadedFacet.isErr()) {
      return Result.err(loadedFacet.error.code);
    }

    return Result.ok({
      fetcher: facets.get(mainFacetName(artifact.harnessCommit, "serving"), () => ({
        class: loadedFacet.value.facetClass,
      })),
    });
  }

  async get(harnessCommit: HarnessCommit): Promise<RetainedHarnessArtifactResult> {
    const validatedCommit = parseHarnessCommit(harnessCommit);
    if (validatedCommit === undefined) {
      return Result.err({ code: "invalid-harness-commit", harnessCommit });
    }

    let object: R2ObjectBody | null;
    try {
      object = await this.bucket.get(artifactKey(validatedCommit));
    } catch {
      return Result.err({ code: "artifact-read-failed", harnessCommit: validatedCommit });
    }

    if (object === null) {
      return Result.ok();
    }

    let value: MainHarnessArtifactInput;
    try {
      value = await object.json<MainHarnessArtifactInput>();
    } catch {
      return Result.err({ code: "corrupt-artifact", harnessCommit: validatedCommit });
    }

    const parsed = MainHarnessArtifact.parse(value);
    if (parsed.isErr() || parsed.value.harnessCommit !== validatedCommit) {
      return Result.err({ code: "corrupt-artifact", harnessCommit: validatedCommit });
    }

    return Result.ok(artifactInput(parsed.value));
  }

  private async write(
    input: MainHarnessArtifactInput,
    effect: "retained" | "rebuilt",
  ): Promise<HarnessArtifactResult> {
    const validatedCommit = parseHarnessCommit(input.harnessCommit);
    if (validatedCommit === undefined) {
      return Result.err({ code: "invalid-harness-commit", harnessCommit: input.harnessCommit });
    }

    try {
      await this.bucket.put(artifactKey(validatedCommit), JSON.stringify(input), {
        httpMetadata: { contentType: "application/json" },
      });
    } catch {
      return Result.err({ code: "artifact-write-failed", harnessCommit: validatedCommit });
    }

    return Result.ok({ artifact: input, effect });
  }
}

function artifactKey(harnessCommit: HarnessCommit): string {
  return `${MODULE_MAP_PREFIX}${harnessCommit}`;
}

function artifactInput(artifact: MainHarnessArtifact): MainHarnessArtifactInput {
  return {
    harnessCommit: artifact.harnessCommit,
    entryModule: artifact.modules[0].name,
    modules: artifact.modules.map((module) => ({ name: module.name, source: module.source })),
  };
}

function sameArtifact(left: MainHarnessArtifactInput, right: MainHarnessArtifactInput): boolean {
  if (left.entryModule !== right.entryModule || left.modules.length !== right.modules.length) {
    return false;
  }

  const sourcesByName = new Map(left.modules.map((module) => [module.name, module.source]));
  return right.modules.every((module) => sourcesByName.get(module.name) === module.source);
}

export { mainFacetName } from "./facet-name.js";
