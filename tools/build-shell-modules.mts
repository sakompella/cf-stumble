import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { shellModulesAssetDirectory } from "../infra/worker-settings.ts";
import { SHELL_MODULES_FILE } from "../src/workspace/project/shell-modules.ts";

const repoRoot = resolve(import.meta.dirname, "..");

const outputFile = join(resolve(repoRoot, shellModulesAssetDirectory), SHELL_MODULES_FILE);

const ENTRY = `
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SHELL_RUNTIME_MODULES, assembleShellModules } from "@cloudflare/computer/backends/worker-shell";
import jq from "@cloudflare/computer/shell/jq";
import yq from "@cloudflare/computer/shell/yq";

const modules = { ...assembleShellModules([jq, yq]), ...SHELL_RUNTIME_MODULES };

mkdirSync(dirname(${JSON.stringify(outputFile)}), { recursive: true });
writeFileSync(${JSON.stringify(outputFile)}, JSON.stringify({ mainModule: "shell.js", modules }));
`;

const WORKERS_STUB = "export class WorkerEntrypoint {}";

const BASH_STUB = "export const Bash = undefined; export const defineCommand = undefined;";

const scratch = await mkdtemp(join(repoRoot, "node_modules", ".shell-modules-"));

const stub = join(scratch, "workers-stub.mjs");

const bashStub = join(scratch, "bash-stub.mjs");

const bundle = join(scratch, "writer.mjs");

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

await rm(scratch, { recursive: true });
