import type { HarnessBuildStepName, HarnessBuildStepRequest } from "../../../src/harness-build.js";
import type {
  CommandAnswer,
  ModuleMapAnswer,
} from "../../../src/workspace/commands/command-result.js";
import type { WorkspaceHostRpc } from "../../../src/workspace/host-rpc.js";

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

export class BuildHost implements WorkspaceHostRpc<"build" | "buildOutput" | "discardBuild"> {
  readonly requests: string[] = [];
  failing: HarnessBuildStepName | undefined;

  build(request: HarnessBuildStepRequest): Promise<CommandAnswer> {
    this.requests.push(request.step);

    return Promise.resolve({
      ok: true,
      output: { stdout: "", stderr: "", exitCode: request.step === this.failing ? 2 : 0 },
    });
  }

  buildOutput(): Promise<ModuleMapAnswer> {
    this.requests.push("output");

    return Promise.resolve({ ok: true, moduleMap: builtModuleMapFile });
  }

  discardBuild(): Promise<CommandAnswer> {
    this.requests.push("discard");

    return Promise.resolve({ ok: true, output: { stdout: "", stderr: "", exitCode: 0 } });
  }

  builds(): number {
    return this.requests.filter((request) => request === "output").length;
  }
}

export const unreachableHost: WorkspaceHostRpc<"build" | "buildOutput" | "discardBuild"> = {
  build: () => Promise.resolve({ ok: false, error: { code: "workspace-unavailable" } }),
  buildOutput: () => Promise.resolve({ ok: false, error: { code: "workspace-unavailable" } }),
  discardBuild: () => Promise.resolve({ ok: false, error: { code: "workspace-unavailable" } }),
};
