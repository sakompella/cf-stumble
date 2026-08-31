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

export type HarnessArtifactResult =
  | {
      readonly ok: true;
      readonly artifact: MainHarnessArtifactInput;
      readonly effect: "retained" | "verified";
    }
  | {
      readonly ok: false;
      readonly problem:
        | MainHarnessArtifactProblem
        | { readonly code: "retained-artifact-mismatch"; readonly harnessCommit: string };
    };

export type RetainedHarnessArtifactResult =
  | { readonly ok: true; readonly artifact: MainHarnessArtifactInput | undefined }
  | { readonly ok: false; readonly problem: MainHarnessArtifactProblem };

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
    if (!retainedFixture.ok) {
      throw new Error(`invalid fixture harness artifact: ${retainedFixture.problem.code}`);
    }
  }

  retain(input: MainHarnessArtifactInput): HarnessArtifactResult {
    const parsed = MainHarnessArtifact.parse(input);
    if (!parsed.ok) {
      return parsed;
    }

    const canonicalInput = artifactInput(parsed.artifact);
    return this.storage.transactionSync(() => {
      const retained = this.get(parsed.artifact.harnessCommit);
      if (!retained.ok) {
        return retained;
      }

      if (retained.artifact !== undefined) {
        return sameArtifact(retained.artifact, canonicalInput)
          ? { ok: true, artifact: retained.artifact, effect: "verified" }
          : {
              ok: false,
              problem: {
                code: "retained-artifact-mismatch",
                harnessCommit: parsed.artifact.harnessCommit,
              },
            };
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

      return { ok: true, artifact: canonicalInput, effect: "retained" };
    });
  }

  mount(
    active: ActiveGeneration,
    loader: WorkerLoader,
    facets: DurableObjectState["facets"],
  ): { readonly fetcher: Fetcher } | { readonly problem: string } {
    const retained =
      active.generation === undefined
        ? this.retain(fixtureMainHarnessArtifact)
        : this.get(active.generation.harnessCommit);
    if (!retained.ok || retained.artifact === undefined) {
      return {
        problem: retained.ok ? "retained artifact was not found" : retained.problem.code,
      };
    }

    const loadedFacet = loadMainFacet(loader, retained.artifact);
    if (!loadedFacet.ok) {
      return { problem: loadedFacet.problem.code };
    }

    return {
      fetcher: facets.get(mainFacetName(retained.artifact.harnessCommit, "serving"), () => ({
        class: loadedFacet.facetClass,
      })),
    };
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
      return { ok: true, artifact: undefined };
    }

    const entryModule = modules.find((module) => module.is_entry === 1)?.module_name;
    const parsed = MainHarnessArtifact.parse({
      harnessCommit,
      entryModule: entryModule ?? "",
      modules: modules.map((module) => ({ name: module.module_name, source: module.source })),
    });
    if (!parsed.ok) {
      return parsed;
    }

    return { ok: true, artifact: artifactInput(parsed.artifact) };
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
