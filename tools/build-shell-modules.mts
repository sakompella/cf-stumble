import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { SHELL_MODULES_FILE, shellModulesAssetDirectory } from "../infra/worker-settings.ts";

const repoRoot = resolve(import.meta.dirname, "..");

const outputFile = join(resolve(repoRoot, shellModulesAssetDirectory), SHELL_MODULES_FILE);

const EGRESS_SHELL_MODULE = `
import { ShellWorker as BaseShellWorker } from "./shell.js";

const ERRNO_BY_MESSAGE = [
  [/^WorkspaceFsError: (no such|parent directory missing|dangling dirent)/, "ENOENT"],
  [/^WorkspaceFsError: path exists/, "EEXIST"],
  [/^WorkspaceFsError: (path is a directory|cannot write to the root directory|cannot overwrite directory)/, "EISDIR"],
  [/^WorkspaceFsError: (parent path segment is not a directory|not a directory|cannot overwrite non-directory)/, "ENOTDIR"],
  [/^WorkspaceFsError: (not empty|directory not empty)/, "ENOTEMPTY"],
];

function withErrnoCode(error) {
  if (error instanceof Error && error.code === undefined) {
    error.code = ERRNO_BY_MESSAGE.find(([pattern]) => pattern.test(error.message))?.[1];
  }

  return error;
}

function withErrnoCodes(workspace) {
  const fs = workspace.fs;
  const guarded = new Proxy(fs, {
    get: (target, key) =>
      typeof key !== "string" || key === "then" || key === "dup" || key === "onRpcBroken"
        ? target[key]
        : async (...args) => {
            try {
              return await target[key](...args);
            } catch (error) {
              throw withErrnoCode(error);
            }
          },
  });

  return new Proxy(workspace, { get: (target, key) => (key === "fs" ? guarded : target[key]) });
}

export class ShellWorker extends BaseShellWorker {
  #workspace;

  constructor(ctx, env) {
    super(ctx, { ...env, HOST: { getWorkspace: async () => withErrnoCodes(this.#workspace) } });
  }

  exec({ workspace, ...input }) {
    this.#workspace = workspace;
    return super.exec(input);
  }

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
