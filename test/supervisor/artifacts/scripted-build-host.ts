import { vi } from "vitest";
import { textLines } from "../../log-capture.js";
import { resultOf } from "../../effect-result.js";
import { testHarnessCommit } from "../../harness-commit-fixtures.js";
import type { HarnessBuildStepName, HarnessBuildStepRequest } from "../../../src/harness-build.js";
import { buildModuleMap } from "../../../src/supervisor/artifacts/build.js";
import type { CommandOutput } from "../../../src/workspace/index.js";
import type {
  CommandAnswer,
  ModuleMapAnswer,
} from "../../../src/workspace/commands/command-result.js";
import type { WorkspaceHostRpc } from "../../../src/workspace/host-rpc.js";

export const BUILD_COMMIT = testHarnessCommit("6000000000000000000000000000000000000001");

export const entryModule = { name: "main.js", source: "export default { fetch() {} };\n" };

export const helperModule = { name: "helper.js", source: "export const help = 1;\n" };

export function moduleMapFile(
  modules: readonly Readonly<{ name: string; source: string }>[],
): string {
  return JSON.stringify({ entryModule: "main.js", modules });
}

export function failureLines(): () => string[] {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});

  return () =>
    textLines(errors)
      .filter((line) => line.startsWith("harness-build."))
      .map((line) => line.slice(0, line.indexOf(": ", line.indexOf(": ") + 2)));
}

export type BuildWorkspaceFake = WorkspaceHostRpc<"build" | "buildOutput" | "discardBuild">;

const PUBLISH_FAILED: ModuleMapAnswer = {
  ok: false,
  error: { code: "publish-failed", output: { stdout: "", stderr: "", exitCode: 1 } },
};

export class FakeBuildHost implements BuildWorkspaceFake {
  readonly requests: string[] = [];
  output: string | undefined = moduleMapFile([helperModule, entryModule]);
  answers: Partial<Record<string, CommandOutput>> = {};

  build(request: HarnessBuildStepRequest): Promise<CommandAnswer> {
    this.requests.push(request.step);

    return Promise.resolve({
      ok: true,
      output: this.answers[request.step] ?? { stdout: "", stderr: "", exitCode: 0 },
    });
  }

  buildOutput(): Promise<ModuleMapAnswer> {
    this.requests.push("build-output");

    return Promise.resolve(
      this.output === undefined ? PUBLISH_FAILED : { ok: true, moduleMap: this.output },
    );
  }

  discardBuild(): Promise<CommandAnswer> {
    this.requests.push("build-discard");

    return Promise.resolve({ ok: true, output: { stdout: "", stderr: "", exitCode: 0 } });
  }

  steps(): readonly string[] {
    return this.requests;
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

export function built(host: BuildWorkspaceFake) {
  return resultOf(buildModuleMap(() => host, BUILD_COMMIT));
}
