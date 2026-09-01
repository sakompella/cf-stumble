import { execFile } from "node:child_process";
import { cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { build } from "esbuild";

const vendorRoot = import.meta.dirname;
const distRoot = resolve(vendorRoot, "dist");
const userAgentModule = resolve(vendorRoot, "packages/ai/src/utils/pi-user-agent.ts");
const userAgentShim = resolve(vendorRoot, "pi-user-agent-shim.ts");

await rm(distRoot, { recursive: true, force: true });
await runTypeScript("tsconfig.declarations.json");
await copyThirdPartyShims(distRoot, "index.d.ts");
await rewriteInternalDeclarationImports(distRoot);
await runTypeScript("tsconfig.declarations.json", ["--outDir", resolve(distRoot, "upstream")]);
await copyThirdPartyShims(resolve(distRoot, "upstream"), "upstream-surface.d.ts");
await rewriteInternalDeclarationImports(resolve(distRoot, "upstream"));
await build({
  entryPoints: [resolve(vendorRoot, "index.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2023",
  conditions: ["workerd", "worker", "browser"],
  alias: {
    "@earendil-works/pi-ai": resolve(vendorRoot, "ai-facade.ts"),
    "@earendil-works/pi-telemetry": resolve(vendorRoot, "telemetry-facade.ts"),
  },
  plugins: [
    {
      name: "workerd-pi-user-agent",
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /pi-user-agent\.ts$/ }, (arguments_) =>
          resolve(arguments_.resolveDir, arguments_.path) === userAgentModule
            ? { path: userAgentShim }
            : undefined,
        );
      },
    },
  ],
  outfile: resolve(distRoot, "index.js"),
});
await runTypeScript("tsconfig.declaration-conformance.json");

async function runTypeScript(project: string, arguments_: readonly string[] = []): Promise<void> {
  const tsc = resolve(vendorRoot, "../../node_modules/typescript/bin/tsc");
  await new Promise<void>((resolveBuild, reject) => {
    execFile(process.execPath, [tsc, "--project", resolve(vendorRoot, project), ...arguments_], (error, stdout, stderr) => {
      if (error) {
        const diagnostics = `${stdout}${stderr}`.trim();
        const stage =
          project === "tsconfig.declaration-conformance.json"
            ? "Declaration conformance check"
            : "Declaration build";
        reject(new Error(`${stage} failed for ${project}${diagnostics ? `\n${diagnostics}` : ""}`, { cause: error }));
        return;
      }
      resolveBuild();
    });
  });
}

async function copyThirdPartyShims(declarationRoot: string, entryDeclaration: string): Promise<void> {
  await cp(resolve(vendorRoot, "third-party-shims.d.ts"), resolve(declarationRoot, "third-party-shims.d.ts"));
  const entry = resolve(declarationRoot, entryDeclaration);
  const contents = await readFile(entry, "utf8");
  await writeFile(entry, `/// <reference path="./third-party-shims.d.ts" />\n${contents}`);
}

async function rewriteInternalDeclarationImports(declarationRoot: string): Promise<void> {
  const aiFacade = resolve(declarationRoot, "ai-facade.d.ts");
  const telemetryFacade = resolve(declarationRoot, "telemetry-facade.d.ts");
  for (const declaration of await declarationFiles(declarationRoot)) {
    const contents = await readFile(declaration, "utf8");
    const rewritten = contents
      .replaceAll("@earendil-works/pi-ai", declarationImport(declaration, aiFacade))
      .replaceAll("@earendil-works/pi-telemetry", declarationImport(declaration, telemetryFacade));
    if (rewritten !== contents) await writeFile(declaration, rewritten);
  }
}

function declarationImport(from: string, to: string): string {
  const path = relative(dirname(from), to).replace(/\.d\.ts$/u, ".js");
  return path.startsWith(".") ? path : `./${path}`;
}

async function declarationFiles(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...(await declarationFiles(entryPath)));
    else if (entry.isFile() && entry.name.endsWith(".d.ts")) files.push(entryPath);
  }
  return files;
}
