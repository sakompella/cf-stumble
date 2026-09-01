import { Result } from "better-result";
import {
  fixtureMainHarnessArtifact,
  loadMainFacet,
  MainHarnessArtifact,
} from "../../facet/index.js";
import type { MainHarnessArtifactInput, MainHarnessArtifactProblem } from "../../facet/index.js";
import type { HarnessCommit } from "../../harness-commit.js";
import { mainFacetName } from "./facet-name.js";
import type { ActiveGeneration } from "../generations/index.js";

type ArtifactModuleRow = {
  readonly module_name: string;
  readonly source: string;
  readonly is_entry: number;
};

export type HarnessArtifactProblem =
  | MainHarnessArtifactProblem
  | { readonly code: "retained-artifact-mismatch"; readonly harnessCommit: string };

export type HarnessArtifactResult = Result<
  { readonly artifact: MainHarnessArtifactInput; readonly effect: "retained" | "verified" },
  HarnessArtifactProblem
>;

export type RetainedHarnessArtifactResult = Result<
  MainHarnessArtifactInput | void,
  MainHarnessArtifactProblem
>;

export class HarnessArtifacts {
  private readonly storage: DurableObjectStorage;
  private readonly sql: SqlStorage;

  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
    this.sql = storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS harness_artifact_modules (
        harness_commit TEXT NOT NULL,
        module_name TEXT NOT NULL,
        source TEXT NOT NULL,
        is_entry INTEGER NOT NULL CHECK (is_entry IN (0, 1)),
        PRIMARY KEY (harness_commit, module_name)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS harness_artifact_one_entry
        ON harness_artifact_modules (harness_commit)
        WHERE is_entry = 1;
    `);

    const retainedFixture = this.retain(fixtureMainHarnessArtifact);
    if (retainedFixture.isErr()) {
      throw new Error(`invalid fixture harness artifact: ${retainedFixture.error.code}`);
    }
  }

  retain(input: MainHarnessArtifactInput): HarnessArtifactResult {
    const parsed = MainHarnessArtifact.parse(input);
    if (parsed.isErr()) {
      return Result.err(parsed.error);
    }

    const canonicalInput = artifactInput(parsed.value);
    return this.storage.transactionSync(() => {
      const retained = this.get(parsed.value.harnessCommit);
      if (retained.isErr()) {
        return Result.err(retained.error);
      }

      if (retained.value !== undefined) {
        return sameArtifact(retained.value, canonicalInput)
          ? Result.ok({ artifact: retained.value, effect: "verified" })
          : Result.err({
              code: "retained-artifact-mismatch",
              harnessCommit: parsed.value.harnessCommit,
            });
      }

      for (const [index, module] of canonicalInput.modules.entries()) {
        this.sql.exec(
          `INSERT INTO harness_artifact_modules (harness_commit, module_name, source, is_entry)
           VALUES (?, ?, ?, ?)`,
          canonicalInput.harnessCommit,
          module.name,
          module.source,
          index === 0 ? 1 : 0,
        );
      }

      return Result.ok({ artifact: canonicalInput, effect: "retained" });
    });
  }

  mount(
    active: ActiveGeneration,
    loader: WorkerLoader,
    facets: DurableObjectState["facets"],
  ): Result<{ readonly fetcher: Fetcher }, string> {
    const retained =
      active.generation === undefined
        ? this.retain(fixtureMainHarnessArtifact)
        : this.get(active.generation.harnessCommit);
    if (retained.isErr()) {
      return Result.err(retained.error.code);
    }

    if (retained.value === undefined) {
      return Result.err("retained artifact was not found");
    }

    const artifact = "artifact" in retained.value ? retained.value.artifact : retained.value;
    const loadedFacet = loadMainFacet(loader, artifact);
    if (loadedFacet.isErr()) {
      return Result.err(loadedFacet.error.code);
    }

    return Result.ok({
      fetcher: facets.get(mainFacetName(artifact.harnessCommit, "serving"), () => ({
        class: loadedFacet.value.facetClass,
      })),
    });
  }

  get(harnessCommit: HarnessCommit): RetainedHarnessArtifactResult {
    const modules = this.sql
      .exec<ArtifactModuleRow>(
        `SELECT module_name, source, is_entry
         FROM harness_artifact_modules
         WHERE harness_commit = ?
         ORDER BY is_entry DESC, module_name ASC`,
        harnessCommit,
      )
      .toArray();

    if (modules.length === 0) {
      return Result.ok();
    }

    const entryModule = modules.find((module) => module.is_entry === 1)?.module_name;
    const parsed = MainHarnessArtifact.parse({
      harnessCommit,
      entryModule: entryModule ?? "",
      modules: modules.map((module) => ({ name: module.module_name, source: module.source })),
    });
    if (parsed.isErr()) {
      return Result.err(parsed.error);
    }

    return Result.ok(artifactInput(parsed.value));
  }
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
