import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import { num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { ComputerEnv } from "./execution-env.js";

const BACKEND_DESCRIPTION = [
  "Where the command runs; both see the same workspace files. Default: container.",
  "isolate: a fast shell in a Worker isolate that starts at once and costs little.",
  "Use it for reading and editing files: ls, cat, head, tail, grep, find, sed, awk, sort, wc and diff.",
  "It has no git, node, npm, pnpm, python, gh, jq or curl, and no network.",
  "container: a Linux machine with the project's toolchain and the internet.",
  "Use it for git, to install dependencies, build, run tests, run node or gh, and for anything the isolate cannot run.",
].join(" ");

const bash = createBashTool();

const parameters = obj(
  {
    command: str({ description: "Bash command to execute" }),
    timeout: opt(num({ description: "Timeout in seconds (optional, no default timeout)" })),
    backend: opt(oneOf(["isolate", "container"], { description: BACKEND_DESCRIPTION })),
  },
  { open: true },
);

function isComputerEnv(env: ExecutionEnv | undefined): env is ComputerEnv {
  return env !== undefined && "onBackend" in env;
}

function inIsolate<Api extends ToolExecutionApi>(api: Api): Api {
  const { env } = api;

  return isComputerEnv(env) ? { ...api, env: env.onBackend("isolate") } : api;
}

const backendBash = defineTool({
  name: bash.name,
  description: bash.description,
  structuredOutputSchema: bash.structuredOutputSchema ?? {},
  outputLimits: bash.outputLimits ?? {},
  parameters,
  execute: (args, api, context) =>
    bash.execute(args, args.backend === "isolate" ? inIsolate(api) : api, context),
});

export const CodingTools = defineExtension({
  name: "coding-tools",
  tools: [createReadTool(), createWriteTool(), createEditTool(), backendBash],
});
