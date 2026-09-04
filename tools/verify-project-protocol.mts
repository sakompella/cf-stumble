import { resolve } from "node:path";
import { build } from "esbuild";

const repoRoot = resolve(import.meta.dirname, "..");
const entryPoint = resolve(repoRoot, "src/workspace/project/protocol.ts");
const forbidden = [
  "src/workspace/host.ts",
  "src/workspace/project/computer-adapter.ts",
  "@cloudflare/computer",
  "node:",
];

const result = await build({
  entryPoints: [entryPoint],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2023",
  write: false,
  metafile: true,
  legalComments: "none",
});

const inputs = Object.entries(result.metafile.inputs);
const violations = inputs.flatMap(([path, input]) => {
  const paths = [path, ...input.imports.map((entry) => entry.path)];
  return paths.filter((candidate) => forbidden.some((prefix) => candidate.includes(prefix)));
});

if (violations.length > 0) {
  throw new Error(`project protocol imports Worker-unsafe modules: ${violations.join(", ")}`);
}
