import { Result } from "better-result";
import { MainHarnessArtifact } from "../../facet/index.js";
import type { MainHarnessArtifactInput } from "../../facet/index.js";
import type { HarnessArtifactProblem, HarnessArtifacts } from "../artifacts/index.js";
import type { Generation, GenerationLabel } from "../generations/index.js";

/**
 * Where the module map under check comes from. `resolved` is the ADR-0034 path: the labeled commit
 * is read from the R2 cache or built from the commit. `submitted` checks a map the caller already
 * holds, which is how a test supplies one without a build workspace.
 */
export type StartupModuleMapSource =
  | Readonly<{ kind: "resolved" }>
  | Readonly<{ kind: "submitted"; input: MainHarnessArtifactInput }>;

export type StartupModuleMapProblem =
  | HarnessArtifactProblem
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
  if (source.kind === "resolved") {
    const resolved = await artifacts.resolve(generation.harnessCommit);
    return resolved.isErr() ? Result.err(resolved.error) : Result.ok(resolved.value.moduleMap);
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

  const retained = await artifacts.retain(source.input);
  return retained.isErr() ? Result.err(retained.error) : Result.ok(retained.value.artifact);
}
