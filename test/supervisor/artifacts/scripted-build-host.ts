import { resultOf } from "../../effect-result.js";
import { testHarnessCommit } from "../../harness-commit-fixtures.js";
import type { HarnessBuildRequest, HarnessBuildStepName } from "../../../src/harness-build.js";
import { buildModuleMap } from "../../../src/supervisor/artifacts/build.js";
import type { CommandOutput } from "../../../src/workspace/index.js";
import type { WorkspaceCommandResult } from "../../../src/workspace/commands/command-result.js";
import type { WorkspaceHostRpc } from "../../../src/workspace/host-rpc.js";

export const BUILD_COMMIT = testHarnessCommit("6000000000000000000000000000000000000001");

export const entryModule = { name: "main.js", source: "export default { fetch() {} };\n" };

export const helperModule = { name: "helper.js", source: "export const help = 1;\n" };

export function moduleMapFile(
  modules: readonly Readonly<{ name: string; source: string }>[],
): string {
  return JSON.stringify({ entryModule: "main.js", modules });
}

function answered(output: CommandOutput): Promise<WorkspaceCommandResult> {
  return Promise.resolve({ ok: true, result: { kind: "command", ...output } });
}

export class FakeBuildHost implements WorkspaceHostRpc<"build"> {
  readonly requests: HarnessBuildRequest[] = [];
  output: string | undefined = moduleMapFile([helperModule, entryModule]);
  answers: Partial<Record<HarnessBuildStepName, CommandOutput>> = {};

  build(request: HarnessBuildRequest): Promise<WorkspaceCommandResult> {
    this.requests.push(request);

    if (request.kind === "build-output") {
      return answered(
        this.output === undefined
          ? { stdout: "", stderr: "", exitCode: 1 }
          : { stdout: this.output, stderr: "", exitCode: 0 },
      );
    }

    const answer = request.kind === "build-step" ? this.answers[request.step] : undefined;

    return answered(answer ?? { stdout: "", stderr: "", exitCode: 0 });
  }

  steps(): readonly string[] {
    return this.requests.map((request) =>
      request.kind === "build-step" ? request.step : request.kind,
    );
  }
}

export function failingAt(
  step: HarnessBuildStepName,
  output: Partial<CommandOutput>,
): FakeBuildHost {
  const host = new FakeBuildHost();
  host.answers = { [step]: { stdout: "", stderr: "", exitCode: 7, ...output } };

  return host;
}

export function built(host: WorkspaceHostRpc<"build">) {
  return resultOf(buildModuleMap(() => host, BUILD_COMMIT));
}
