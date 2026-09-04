import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

/* eslint-disable max-lines -- The updater owns the generated declaration facade with the copied files. */

type UpstreamPin = {
  readonly repository: string;
  readonly tag: string;
  readonly commit: string;
  readonly copiedPaths: readonly string[];
  readonly command: string;
  readonly localOverrides: readonly LocalOverride[];
};

type LocalOverride = {
  readonly upstreamPath: string;
  readonly localPath: string;
  readonly purpose: string;
};

const repoRoot = resolve(import.meta.dirname, "..");
const vendorRoot = resolve(repoRoot, "vendor/pi-v0.84.4");
const defaultSource = process.env.CF_STUMBLE_PI_SOURCE ?? "/tmp/cf-stumble-pi-v0.84.4";
const upstreamPinSchema = Type.Object({
  repository: Type.String(),
  tag: Type.String(),
  commit: Type.String(),
  copiedPaths: Type.Array(Type.String()),
  command: Type.String(),
  localOverrides: Type.Array(
    Type.Object({
      upstreamPath: Type.String(),
      localPath: Type.String(),
      purpose: Type.String(),
    }),
  ),
});

type ParsedUpstreamPin = Static<typeof upstreamPinSchema>;

const pin: UpstreamPin = {
  repository: "https://github.com/earendil-works/pi.git",
  tag: "v0.84.4",
  commit: "b79e4cc834970cca69daebffab7df1da7d1e52c4",
  copiedPaths: [
    "LICENSE",
    "packages/agent/src",
    "packages/agent/package.json",
    "packages/agent/README.md",
    "packages/ai/src",
    "packages/ai/package.json",
    "packages/ai/README.md",
    "packages/telemetry/src",
    "packages/telemetry/package.json",
    "packages/telemetry/README.md",
  ],
  command: "pnpm exec tsx tools/vendor-pi.mts --update --source /tmp/cf-stumble-pi-v0.84.4",
  localOverrides: [
    {
      upstreamPath: "packages/ai/src/utils/pi-user-agent.ts",
      localPath: "pi-user-agent-shim.ts",
      purpose:
        "Replace node:os runtime detection with a fixed Worker-safe user agent during bundling.",
    },
  ],
};

// These are separate generated sources. The facade selects the Worker-safe package surface,
// while the check imports the corresponding exports from the vendored upstream entrypoints.
const piFacadeSurfaceSource = `export { Agent } from "./packages/agent/src/agent.ts";
export type { AgentOptions } from "./packages/agent/src/agent.ts";
export { createReadTool } from "./packages/agent/src/harness/tools/read.ts";
export { createWriteTool } from "./packages/agent/src/harness/tools/write.ts";
export { createEditTool } from "./packages/agent/src/harness/tools/edit.ts";
export { createBashTool } from "./packages/agent/src/harness/tools/bash.ts";
export { FileError, ExecutionError } from "./packages/agent/src/harness/types.ts";
export type {
  AgentHarnessTool,
  ExecutionEnv,
  FileSystem,
  Shell,
  FileInfo,
  ShellExecOptions,
  Result,
} from "./packages/agent/src/harness/types.ts";
export type { ExecutionToolContext } from "./packages/agent/src/harness/tools/tool-context.ts";
export type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  AgentState,
  StreamFn,
} from "./packages/agent/src/types.ts";
export type {
  BashExecutionMessage,
  CustomMessage,
  BranchSummaryMessage,
  CompactionSummaryMessage,
} from "./packages/agent/src/harness/messages.ts";
export { streamSimple } from "./packages/ai/src/api/openai-completions.ts";
export { createGatewayBindingFetch } from "./packages/ai/src/api/cloudflare-gateway-binding.ts";
export type { AiGatewayBinding } from "./packages/ai/src/api/cloudflare-gateway-binding.ts";
export {
  AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "./packages/ai/src/utils/event-stream.ts";
export type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  ToolCall,
  ToolResultMessage,
} from "./packages/ai/src/types.ts";
`;

const piUpstreamSurfaceSource = `export { Agent } from "./packages/agent/src/index.ts";
export type { AgentOptions } from "./packages/agent/src/index.ts";
export { createReadTool } from "./packages/agent/src/index.ts";
export { createWriteTool } from "./packages/agent/src/index.ts";
export { createEditTool } from "./packages/agent/src/index.ts";
export { createBashTool } from "./packages/agent/src/index.ts";
export { FileError, ExecutionError } from "./packages/agent/src/index.ts";
export type {
  AgentHarnessTool,
  ExecutionEnv,
  FileSystem,
  Shell,
  FileInfo,
  ShellExecOptions,
  Result,
} from "./packages/agent/src/index.ts";
export type { ExecutionToolContext } from "./packages/agent/src/index.ts";
export type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  AgentState,
  StreamFn,
} from "./packages/agent/src/index.ts";
export type {
  BashExecutionMessage,
  CustomMessage,
  BranchSummaryMessage,
  CompactionSummaryMessage,
} from "./packages/agent/src/index.ts";
export { streamSimple } from "./packages/ai/src/api/openai-completions.ts";
export { createGatewayBindingFetch } from "./packages/ai/src/api/cloudflare-gateway-binding.ts";
export type { AiGatewayBinding } from "./packages/ai/src/api/cloudflare-gateway-binding.ts";
export {
  AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "./packages/ai/src/index.ts";
export type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  ToolCall,
  ToolResultMessage,
} from "./packages/ai/src/index.ts";
`;

// The vendored AI barrel does not export streamSimple, createGatewayBindingFetch, or
// AiGatewayBinding, so those three checks cannot compare against an independent barrel source.

const generatedFiles = new Map<string, string>([
  [
    "package.json",
    `${JSON.stringify(
      {
        name: "@cf-stumble/pi",
        private: true,
        version: "0.84.4",
        type: "module",
        exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
        types: "./dist/index.d.ts",
        scripts: {
          build: "tsx build.mts",
        },
        dependencies: {
          diff: "8.0.4",
          openai: "6.40.0",
          "partial-json": "0.1.7",
          typebox: "1.3.7",
        },
      },
      undefined,
      2,
    )}\n`,
  ],
  ["index.ts", piFacadeSurfaceSource],
  ["upstream-surface.ts", piUpstreamSurfaceSource],
  [
    "ai-facade.ts",
    `export { EventStream } from "./packages/ai/src/utils/event-stream.ts";
export { validateToolArguments } from "./packages/ai/src/utils/validation.ts";
export type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  Message,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingBudgets,
  Tool,
  ToolResultMessage,
  Transport,
  Usage,
} from "./packages/ai/src/types.ts";
`,
  ],
  [
    "telemetry-facade.ts",
    `export type { TelemetryContext } from "./packages/telemetry/src/index.ts";
`,
  ],
  [
    "pi-user-agent-shim.ts",
    `export function getPiUserAgent(): string {
  return "pi (workerd)";
}
`,
  ],
  [
    "third-party-shims.d.ts",
    `declare module "@anthropic-ai/sdk";
declare module "@anthropic-ai/sdk/resources/messages.js";
declare module "@aws-sdk/client-bedrock-runtime";
declare module "@google/genai";
declare module "@smithy/node-http-handler";
declare module "@smithy/types";
declare module "http-proxy-agent";
declare module "https-proxy-agent";
`,
  ],
  [
    "tsconfig.declarations.json",
    `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "declaration": true,
    "emitDeclarationOnly": true,
    "declarationMap": false,
    "noCheck": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "strict": false,
    "skipLibCheck": true,
    "types": ["node"],
    "rootDir": ".",
    "outDir": "./dist",
    "paths": {
      "@earendil-works/pi-ai": ["./ai-facade.ts"],
      "@earendil-works/pi-telemetry": ["./telemetry-facade.ts"]
    }
  },
  "include": ["index.ts", "upstream-surface.ts", "ai-facade.ts", "telemetry-facade.ts", "third-party-shims.d.ts"]
}
`,
  ],
  [
    "tsconfig.upstream-declarations.json",
    `{
  "extends": "./tsconfig.declarations.json",
  "compilerOptions": {
    "paths": {
      "@earendil-works/pi-ai": ["./packages/ai/src/index.ts"],
      "@earendil-works/pi-telemetry": ["./packages/telemetry/src/index.ts"]
    }
  },
  "include": ["upstream-surface.ts", "third-party-shims.d.ts"]
}
`,
  ],
  [
    "tsconfig.declaration-conformance.json",
    `{
  "extends": "./tsconfig.declarations.json",
  "compilerOptions": {
    "declaration": false,
    "emitDeclarationOnly": false,
    "noCheck": false,
    "noEmit": true,
    "paths": {
      "@cf-stumble/pi": ["./dist/index.d.ts"],
      "@vendored-source/pi": ["./dist/upstream/upstream-surface.d.ts"]
    }
  },
  "include": ["declaration-conformance.ts", "third-party-shims.d.ts"]
}
`,
  ],
  [
    "declaration-conformance.ts",
    `import type * as Exported from "@cf-stumble/pi";
import type * as Upstream from "@vendored-source/pi";

type IsAssignable<From, To> = [From] extends [To] ? true : false;
type Equivalent<Left, Right> = IsAssignable<Left, Right> extends true
  ? IsAssignable<Right, Left>
  : false;
type Assert<T extends true> = T;
type StreamFnShape<Stream> = Stream extends (...arguments_: infer Arguments) => infer Output
  ? {
      arguments: Arguments;
      result: Awaited<Output> extends AsyncIterable<infer Event> & { result(): Promise<infer Final> }
        ? { event: Event; final: Final }
        : never;
    }
  : never;
type AgentOptionsShape<Options> = Options extends { streamFn: infer Stream }
  ? { other: Omit<Options, "streamFn">; stream: StreamFnShape<Stream> }
  : never;
// AssistantMessageEventStream carries private fields, so two separately-compiled declaration
// emits of it are never nominally assignable to each other even when structurally identical.
// Compare the public async-iterable-plus-result shape instead, the same way StreamFnShape does
// for the class instances stream functions return.
type EventStreamShape<Stream> = Stream extends AsyncIterable<infer Event> & {
  result(): Promise<infer Final>;
}
  ? { event: Event; final: Final }
  : never;

export type ExportedTypesConformToVendoredPi = [
  Assert<Equivalent<AgentOptionsShape<Exported.AgentOptions>, AgentOptionsShape<Upstream.AgentOptions>>>,
  Assert<Equivalent<Exported.AgentEvent, Upstream.AgentEvent>>,
  Assert<Equivalent<Exported.AgentMessage, Upstream.AgentMessage>>,
  Assert<Equivalent<Exported.AgentState, Upstream.AgentState>>,
  Assert<Equivalent<Exported.AgentTool, Upstream.AgentTool>>,
  Assert<Equivalent<StreamFnShape<Exported.StreamFn>, StreamFnShape<Upstream.StreamFn>>>,
  Assert<Equivalent<Exported.BashExecutionMessage, Upstream.BashExecutionMessage>>,
  Assert<Equivalent<Exported.CustomMessage, Upstream.CustomMessage>>,
  Assert<Equivalent<Exported.BranchSummaryMessage, Upstream.BranchSummaryMessage>>,
  Assert<Equivalent<Exported.CompactionSummaryMessage, Upstream.CompactionSummaryMessage>>,
  Assert<Equivalent<Exported.Api, Upstream.Api>>,
  Assert<Equivalent<Exported.Model<Exported.Api>, Upstream.Model<Upstream.Api>>>,
  Assert<Equivalent<Exported.ExecutionEnv, Upstream.ExecutionEnv>>,
  Assert<Equivalent<Exported.ExecutionError, Upstream.ExecutionError>>,
  Assert<Equivalent<typeof Exported.ExecutionError, typeof Upstream.ExecutionError>>,
  Assert<Equivalent<Exported.FileError, Upstream.FileError>>,
  Assert<Equivalent<typeof Exported.FileError, typeof Upstream.FileError>>,
  Assert<Equivalent<Exported.FileInfo, Upstream.FileInfo>>,
  Assert<Equivalent<Exported.FileSystem, Upstream.FileSystem>>,
  Assert<Equivalent<Exported.Result<unknown, unknown>, Upstream.Result<unknown, unknown>>>,
  Assert<Equivalent<Exported.Shell, Upstream.Shell>>,
  Assert<Equivalent<Exported.ShellExecOptions, Upstream.ShellExecOptions>>,
  Assert<Equivalent<Exported.ExecutionToolContext, Upstream.ExecutionToolContext>>,
  Assert<
    Equivalent<
      Exported.AgentHarnessTool<Exported.ExecutionToolContext>,
      Upstream.AgentHarnessTool<Upstream.ExecutionToolContext>
    >
  >,
  Assert<Equivalent<typeof Exported.createBashTool, typeof Upstream.createBashTool>>,
  Assert<Equivalent<typeof Exported.createEditTool, typeof Upstream.createEditTool>>,
  Assert<Equivalent<typeof Exported.createReadTool, typeof Upstream.createReadTool>>,
  Assert<Equivalent<typeof Exported.createWriteTool, typeof Upstream.createWriteTool>>,
  Assert<Equivalent<StreamFnShape<typeof Exported.streamSimple>, StreamFnShape<typeof Upstream.streamSimple>>>,
  Assert<Equivalent<Exported.AiGatewayBinding, Upstream.AiGatewayBinding>>,
  Assert<Equivalent<typeof Exported.createGatewayBindingFetch, typeof Upstream.createGatewayBindingFetch>>,
  Assert<Equivalent<Exported.AssistantMessage, Upstream.AssistantMessage>>,
  Assert<Equivalent<Exported.AssistantMessageEvent, Upstream.AssistantMessageEvent>>,
  Assert<Equivalent<Exported.ToolCall, Upstream.ToolCall>>,
  Assert<Equivalent<Exported.ToolResultMessage, Upstream.ToolResultMessage>>,
  Assert<
    Equivalent<
      EventStreamShape<Exported.AssistantMessageEventStream>,
      EventStreamShape<Upstream.AssistantMessageEventStream>
    >
  >,
  Assert<
    Equivalent<
      StreamFnShape<typeof Exported.createAssistantMessageEventStream>,
      StreamFnShape<typeof Upstream.createAssistantMessageEventStream>
    >
  >,
];
`,
  ],
  [
    "build.mts",
    `import { execFile } from "node:child_process";
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
await rewriteInternalDeclarationImports(distRoot, "facade");
const upstreamDistRoot = resolve(distRoot, "upstream");
await runTypeScript("tsconfig.upstream-declarations.json", ["--outDir", upstreamDistRoot]);
await copyThirdPartyShims(upstreamDistRoot, "upstream-surface.d.ts");
await rewriteInternalDeclarationImports(upstreamDistRoot, "upstream");
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
        pluginBuild.onResolve({ filter: /pi-user-agent\\.ts$/ }, (arguments_) =>
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
        const diagnostics = \`\${stdout}\${stderr}\`.trim();
        const stage =
          project === "tsconfig.declaration-conformance.json"
            ? "Declaration conformance check"
            : "Declaration build";
        reject(new Error(\`\${stage} failed for \${project}\${diagnostics ? \`\\n\${diagnostics}\` : ""}\`, { cause: error }));
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
  await writeFile(entry, \`/// <reference path="./third-party-shims.d.ts" />\\n\${contents}\`);
}

async function rewriteInternalDeclarationImports(
  declarationRoot: string,
  declarationSource: "facade" | "upstream",
): Promise<void> {
  const aiDeclaration = resolve(
    declarationRoot,
    declarationSource === "facade" ? "ai-facade.d.ts" : "packages/ai/src/index.d.ts",
  );
  const telemetryDeclaration = resolve(
    declarationRoot,
    declarationSource === "facade" ? "telemetry-facade.d.ts" : "packages/telemetry/src/index.d.ts",
  );
  for (const declaration of await declarationFiles(declarationRoot)) {
    const contents = await readFile(declaration, "utf8");
    const rewritten = contents
      .replaceAll("@earendil-works/pi-ai", declarationImport(declaration, aiDeclaration))
      .replaceAll("@earendil-works/pi-telemetry", declarationImport(declaration, telemetryDeclaration));
    if (rewritten !== contents) await writeFile(declaration, rewritten);
  }
}

function declarationImport(from: string, to: string): string {
  const path = relative(dirname(from), to).replace(/\\.d\\.ts$/u, ".js");
  return path.startsWith(".") ? path : \`./\${path}\`;
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
`,
  ],
]);

async function main(): Promise<void> {
  const [mode, ...arguments_] = process.argv.slice(2);
  if (mode === "--check" && arguments_.length === 0) {
    await checkVendorTree();
    return;
  }
  if (mode === "--refresh-generated" && arguments_.length === 0) {
    await refreshGeneratedFiles();
    return;
  }
  if (mode === "--update") {
    await updateVendorTree(sourceArgument(arguments_));
    return;
  }
  throw new Error(
    "Usage: pnpm exec tsx tools/vendor-pi.mts --check | --refresh-generated | --update [--source <path>]",
  );
}

function sourceArgument(arguments_: readonly string[]): string {
  if (arguments_.length === 0) {
    return defaultSource;
  }
  if (arguments_.length === 2 && arguments_[0] === "--source" && arguments_[1] !== undefined) {
    return resolve(arguments_[1]);
  }
  throw new Error("Usage: --update [--source <path>]");
}

async function updateVendorTree(sourceRoot: string): Promise<void> {
  await verifySourceCheckout(sourceRoot);
  await rm(vendorRoot, { recursive: true, force: true });
  await mkdir(vendorRoot, { recursive: true });

  for (const copiedPath of pin.copiedPaths) {
    await copyUpstreamPath(sourceRoot, copiedPath);
  }
  for (const [path, contents] of generatedFiles) {
    await writeManagedFile(path, contents);
  }
  await writeManagedFile("UPSTREAM.json", `${JSON.stringify(pin, undefined, 2)}\n`);
  await writeChecksums();
}

async function refreshGeneratedFiles(): Promise<void> {
  for (const [path, contents] of generatedFiles) {
    await writeManagedFile(path, contents);
  }
  await writeManagedFile("UPSTREAM.json", `${JSON.stringify(pin, undefined, 2)}\n`);
  await writeChecksums();
}

async function verifySourceCheckout(sourceRoot: string): Promise<void> {
  const [status, commit, tag] = await Promise.all([
    runGit(sourceRoot, ["status", "--porcelain"]),
    runGit(sourceRoot, ["rev-parse", "HEAD"]),
    runGit(sourceRoot, ["describe", "--exact-match", "--tags", "HEAD"]),
  ]);
  if (status !== "") {
    throw new Error(`Pi source checkout is dirty: ${sourceRoot}`);
  }
  if (commit.trim() !== pin.commit) {
    throw new Error(`Pi source checkout is ${commit.trim()}, expected ${pin.commit}`);
  }
  if (tag.trim() !== pin.tag) {
    throw new Error(`Pi source checkout has tag ${tag.trim()}, expected ${pin.tag}`);
  }
}

function runGit(sourceRoot: string, arguments_: readonly string[]): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile("git", ["-C", sourceRoot, ...arguments_], (error, stdout) => {
      if (error) {
        reject(new Error("Unable to inspect the Pi source checkout", { cause: error }));
        return;
      }
      resolveOutput(stdout);
    });
  });
}

async function copyUpstreamPath(sourceRoot: string, copiedPath: string): Promise<void> {
  const sourcePath = resolve(sourceRoot, copiedPath);
  const destinationPath = resolve(vendorRoot, copiedPath);
  const sourceStats = await stat(sourcePath);
  if (!sourceStats.isDirectory()) {
    await mkdir(dirname(destinationPath), { recursive: true });
    await cp(sourcePath, destinationPath, { force: true });
    return;
  }

  await cp(sourcePath, destinationPath, { recursive: true, force: true });
}

async function checkVendorTree(): Promise<void> {
  // SHA256SUMS is itself a generated, mutable file: a template edit that regenerates checksums
  // without regenerating the files it hashes (or a hand-edit of a generated file plus its
  // checksum) would pass the checksum comparison below undetected. Comparing every templated
  // file against its exact expected contents first closes that gap; the checksum pass afterwards
  // still catches drift in copied (non-templated) upstream files.
  await verifyGeneratedFilesMatchTemplates();

  const manifest = await readChecksums();
  const managedPaths = (await filesUnder(vendorRoot))
    .map((file) => relative(vendorRoot, file))
    .filter(
      (path) =>
        path !== "SHA256SUMS" && !path.startsWith("dist/") && !path.startsWith("node_modules/"),
    )
    .toSorted();
  const manifestPaths = [...manifest.keys()].toSorted();
  if (managedPaths.join("\n") !== manifestPaths.join("\n")) {
    throw new Error("SHA256SUMS does not match the managed vendor tree");
  }
  for (const [path, expected] of manifest) {
    const actual = await sha256(resolve(vendorRoot, path));
    if (actual !== expected) {
      throw new Error(`SHA256 mismatch for ${path}`);
    }
  }

  const upstream = await readUpstreamPin();
  if (
    upstream.repository !== pin.repository ||
    upstream.tag !== pin.tag ||
    upstream.commit !== pin.commit
  ) {
    throw new Error("UPSTREAM.json does not match the Pi pin");
  }
  const licence = await readFile(resolve(vendorRoot, "LICENSE"), "utf8");
  if (!licence.startsWith("MIT License\n")) {
    throw new Error("Vendored Pi LICENSE is not the expected MIT license");
  }
  const output = await readFile(resolve(vendorRoot, "dist/index.js"), "utf8");
  if (/\b(?:from|import)\s*["']node:/u.test(output) || /\brequire\s*\(\s*["']node:/u.test(output)) {
    throw new Error("Pi bundle contains a static node: import");
  }
}

async function verifyGeneratedFilesMatchTemplates(): Promise<void> {
  const expectedFiles = new Map([
    ...generatedFiles,
    ["UPSTREAM.json", `${JSON.stringify(pin, undefined, 2)}\n`],
  ]);
  for (const [path, expected] of expectedFiles) {
    const destination = resolve(vendorRoot, path);
    const actual = await readFile(destination, "utf8").catch((cause: unknown) => {
      throw new Error(`Generated file is missing: ${path}`, { cause });
    });
    if (actual !== expected) {
      throw new Error(
        `Generated file ${path} does not match its template. Run \`pnpm exec tsx tools/vendor-pi.mts --refresh-generated\` and inspect the diff.`,
      );
    }
  }
}

async function readUpstreamPin(): Promise<UpstreamPin> {
  const contents = await readFile(resolve(vendorRoot, "UPSTREAM.json"), "utf8");
  const value: unknown = JSON.parse(contents);
  if (!Value.Check(upstreamPinSchema, value)) {
    throw new Error("UPSTREAM.json is not a valid Pi pin");
  }
  const parsed: ParsedUpstreamPin = value;
  return {
    repository: parsed.repository,
    tag: parsed.tag,
    commit: parsed.commit,
    copiedPaths: parsed.copiedPaths,
    command: parsed.command,
    localOverrides: parsed.localOverrides,
  };
}

async function writeChecksums(): Promise<void> {
  const paths = (await filesUnder(vendorRoot))
    .map((file) => relative(vendorRoot, file))
    .filter(
      (path) =>
        path !== "SHA256SUMS" && !path.startsWith("dist/") && !path.startsWith("node_modules/"),
    )
    .toSorted();
  const lines = await Promise.all(
    paths.map(async (path) => `${await sha256(resolve(vendorRoot, path))}  ${path}`),
  );
  await writeManagedFile("SHA256SUMS", `${lines.join("\n")}\n`);
}

async function readChecksums(): Promise<Map<string, string>> {
  const contents = await readFile(resolve(vendorRoot, "SHA256SUMS"), "utf8");
  const entries = contents
    .trim()
    .split("\n")
    .map((line) => {
      const match = /^(?<hash>[a-f0-9]{64})  (?<path>.+)$/u.exec(line);
      if (match?.groups?.hash === undefined || match.groups.path === undefined) {
        throw new Error(`Invalid SHA256SUMS entry: ${line}`);
      }
      return [match.groups.path, match.groups.hash] as const;
    });
  return new Map(entries);
}

async function filesUnder(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = resolve(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesUnder(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

async function writeManagedFile(path: string, contents: string): Promise<void> {
  const destination = resolve(vendorRoot, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, contents);
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
