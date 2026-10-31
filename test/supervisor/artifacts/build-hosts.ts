import type { HarnessBuildRequest, HarnessBuildStepName } from "../../../src/harness-build.js";
import type { BuildWorkspaceHost } from "../../../src/supervisor/artifacts/index.js";
import type { WorkspaceCommandResult } from "../../../src/workspace/index.js";

const builtModuleMapFile = JSON.stringify({
  entryModule: "main.js",
  modules: [
    {
      name: "main.js",
      source: `
import { DurableObject } from "cloudflare:workers";
import { body } from "./body.js";
export class MainFacet extends DurableObject {
  fetch() { return new Response(body); }
}
export default { fetch() { return new Response(body); } };
`,
    },
    { name: "body.js", source: 'export const body = "built module map";\n' },
  ],
});

export class BuildHost implements BuildWorkspaceHost {
  readonly requests: HarnessBuildRequest[] = [];
  failing: HarnessBuildStepName | undefined;

  build(request: HarnessBuildRequest): Promise<WorkspaceCommandResult> {
    this.requests.push(request);
    const failed = request.kind === "build-step" && request.step === this.failing;
    const stdout = request.kind === "build-output" ? builtModuleMapFile : "";

    return Promise.resolve({
      ok: true,
      result: { kind: "command", stdout, stderr: "", exitCode: failed ? 2 : 0 },
    });
  }

  builds(): number {
    return this.requests.filter((request) => request.kind === "build-output").length;
  }

  provisions(): number {
    return this.requests.filter(
      (request) => request.kind === "build-step" && request.step === "provision",
    ).length;
  }
}

export class GatedBuildHost implements BuildWorkspaceHost {
  readonly inner = new BuildHost();
  asked = 0;
  #release: (() => void) | undefined;
  readonly #gate = new Promise<void>((resolve) => {
    this.#release = resolve;
  });

  release(): void {
    this.#release?.();
  }

  async build(request: HarnessBuildRequest): Promise<WorkspaceCommandResult> {
    this.asked += 1;
    await this.#gate;

    return this.inner.build(request);
  }
}

export const unreachableHost: BuildWorkspaceHost = {
  build: () => Promise.resolve({ ok: false, error: { code: "unknown-command" } }),
};
