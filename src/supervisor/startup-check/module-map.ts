import { Result } from "better-result";
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
export async function startupModuleMap(
  artifacts: HarnessArtifacts,
  generation: Generation,
  label: GenerationLabel,
  source: StartupModuleMapSource,
): Promise<Result<MainHarnessArtifactInput, StartupModuleMapProblem>> {
  if (source.kind === "prepared") {
    const prepared = await artifacts.prepare(generation.harnessCommit);

    return prepared.isErr() ? Result.err(prepared.error) : Result.ok(prepared.value);
  }

  const parsed = MainHarnessArtifact.parse(source.input);

  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }

  if (parsed.value.harnessCommit !== generation.harnessCommit) {
    return Result.err({
      code: "artifact-harness-commit-mismatch",
      label,
      generationHarnessCommit: generation.harnessCommit,
      artifactHarnessCommit: parsed.value.harnessCommit,
    });
  }

  const retained = artifacts.retain(source.input);

  return retained.isErr() ? Result.err(retained.error) : Result.ok(retained.value);
}
