import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { MainHarnessArtifact } from "../../facet/index.js";
import type { MainHarnessArtifactInput } from "../../facet/index.js";
import type { HarnessArtifacts, ModuleMapProblem } from "../artifacts/index.js";
import type { Generation, GenerationLabel } from "../generations/index.js";

/**
 * Where the module map under check comes from. `prepared` is the submission path: the labeled
 * commit is read from the Supervisor's store or built from that commit and stored. `submitted`
 * checks a map the caller already holds, which is how a test supplies one without a build
 * workspace.
 */
export type StartupModuleMapSource =
  | Readonly<{ kind: "prepared" }>
  | Readonly<{ kind: "submitted"; input: MainHarnessArtifactInput }>;

export type StartupModuleMapProblem =
  | ModuleMapProblem
  | {
      readonly code: "artifact-harness-commit-mismatch";
      readonly label: number;
      readonly generationHarnessCommit: string;
      readonly artifactHarnessCommit: string;
    };

/** Obtain the module map a startup check should mount, without changing any generation state. */
export function startupModuleMap(
  artifacts: HarnessArtifacts,
  generation: Generation,
  label: GenerationLabel,
  source: StartupModuleMapSource,
): Effect.Effect<MainHarnessArtifactInput, StartupModuleMapProblem> {
  if (source.kind === "prepared") {
    return artifacts.prepare(generation.harnessCommit);
  }

  return Effect.suspend(() =>
    Effect.fromResult(submittedModuleMap(artifacts, generation, label, source.input)),
  );
}

function submittedModuleMap(
  artifacts: HarnessArtifacts,
  generation: Generation,
  label: GenerationLabel,
  input: MainHarnessArtifactInput,
): Result.Result<MainHarnessArtifactInput, StartupModuleMapProblem> {
  const parsed = MainHarnessArtifact.parse(input);

  if (Result.isFailure(parsed)) {
    return Result.fail(parsed.failure);
  }

  if (parsed.success.harnessCommit !== generation.harnessCommit) {
    return Result.fail({
      code: "artifact-harness-commit-mismatch",
      label,
      generationHarnessCommit: generation.harnessCommit,
      artifactHarnessCommit: parsed.success.harnessCommit,
    });
  }

  return artifacts.retain(input);
}
