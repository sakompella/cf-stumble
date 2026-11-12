import {
  defineExtension,
  defineTool,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
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
  "Optional override; leave it out. The host routes each command by itself.",
  "A command whose programs are all simple file tools or curl runs in a fast Worker isolate that starts at once and costs little:",
  "ls, cat, head, tail, grep, find, sed, awk, sort, wc, diff, jq, yq, echo, mkdir, cp, mv, and rm.",
  "curl also runs there for web requests to any host over http(s) with any method and headers; api.github.com gets the workspace's GitHub token automatically, and redirects are followed.",
  "Anything else runs in the container, a Linux machine with the project's toolchain and the internet: git, node, npm, pnpm, python, gh, builds, tests, subshells, $(...), env assignments.",
  "isolate: ask for the isolate; a command it cannot run goes to the container instead, except git, which is refused there.",
  "container: always the container.",
  "Both see the same workspace files.",
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

function onBackend<Api extends ToolExecutionApi>(api: Api, backend: "isolate" | "container"): Api {
  const { env } = api;

  return isComputerEnv(env) ? { ...api, env: env.onBackend(backend) } : api;
}

const backendBash = defineTool({
  name: bash.name,
  description: bash.description,
  structuredOutputSchema: bash.structuredOutputSchema ?? {},
  outputLimits: bash.outputLimits ?? {},
  parameters,
  execute: (args, api, context) =>
    bash.execute(args, args.backend === undefined ? api : onBackend(api, args.backend), context),
});

function logged(tool: ToolRegistration): ToolRegistration {
  return {
    ...tool,
    execute: async (args, api, context) => {
      const started = Date.now();
      let isError = true;

      try {
        const result = await tool.execute(args, api, context);

        isError = result.isError === true;

        return result;
      } finally {
        const log = isComputerEnv(api.env) ? api.env.log : undefined;

        log?.(isError ? "error" : "info", "tool-call", {
          tool: tool.name,
          durationMs: Date.now() - started,
          isError,
        });
      }
    },
  };
}

export const CodingTools = defineExtension({
  name: "coding-tools",
  tools: [createReadTool(), createWriteTool(), createEditTool(), backendBash].map(logged),
});
