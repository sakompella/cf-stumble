import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { SHELL_MODULES_FILE, shellModulesAssetDirectory } from "../infra/worker-settings.ts";

const repoRoot = resolve(import.meta.dirname, "..");

const outputFile = join(resolve(repoRoot, shellModulesAssetDirectory), SHELL_MODULES_FILE);

const EGRESS_SHELL_MODULE = `
import { ShellWorker as BaseShellWorker } from "./shell.js";

export class ShellWorker extends BaseShellWorker {
  shellOptions = {
    fetch: async (url, options) => {
      const response = await this.env.EGRESS.fetch(url, {
        method: options?.method,
        headers: options?.headers,
        body: options?.body,
        redirect: "manual",
        signal: options?.signal,
      });
      const headers = Object.create(null);
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      return {
        status: response.status,
        statusText: response.statusText,
        headers,
        body: new Uint8Array(await response.arrayBuffer()),
        url: response.url || url,
      };
    },
  };
}
`;

const ENTRY = `
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SHELL_RUNTIME_MODULES, assembleShellModules } from "@cloudflare/computer/backends/worker-shell";
import curl from "@cloudflare/computer/shell/curl";
import jq from "@cloudflare/computer/shell/jq";
import yq from "@cloudflare/computer/shell/yq";

const egressShellModule = ${JSON.stringify(EGRESS_SHELL_MODULE)};

const modules = {
  ...assembleShellModules([jq, yq, curl]),
  "isolate-shell.js": { js: egressShellModule },
  ...SHELL_RUNTIME_MODULES,
};

mkdirSync(dirname(${JSON.stringify(outputFile)}), { recursive: true });
writeFileSync(
  ${JSON.stringify(outputFile)},
  JSON.stringify({ mainModule: "isolate-shell.js", modules }),
);
`;

const WORKERS_STUB = "export class WorkerEntrypoint {}";

const BASH_STUB = "export const Bash = undefined; export const defineCommand = undefined;";

const scratch = await mkdtemp(join(repoRoot, "node_modules", ".shell-modules-"));

const stub = join(scratch, "workers-stub.mjs");

const bashStub = join(scratch, "bash-stub.mjs");

const bundle = join(scratch, "writer.mjs");

try {
  await writeFile(stub, WORKERS_STUB);

  await writeFile(bashStub, BASH_STUB);

  await build({
    stdin: { contents: ENTRY, resolveDir: repoRoot },
    outfile: bundle,
    bundle: true,
    format: "esm",
    platform: "node",
    alias: { "cloudflare:workers": stub, "just-bash": bashStub },
    logLevel: "error",
  });

  await import(pathToFileURL(bundle).href);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
