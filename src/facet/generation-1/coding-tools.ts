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
import { MAX_EXEC_TIMEOUT_MS } from "../../workspace/project/protocol.js";
import type { ComputerEnv } from "./execution-env.js";

const LIMIT_SECONDS = MAX_EXEC_TIMEOUT_MS / 1_000;

const BACKEND_DESCRIPTION = [
  "Optional override; leave it out. The host routes each command by itself.",
  "A command whose programs are all simple file tools or curl runs in a fast Worker isolate that starts at once and costs little:",
  "ls, cat, head, tail, grep, find, sed, awk, sort, wc, diff, jq, yq, echo, mkdir, cp, mv, and rm.",
  "curl also runs there for web requests to any host over http(s) with any method and headers; api.github.com gets the workspace's GitHub token automatically, and redirects are followed.",
  "Anything else runs in the container, a Linux machine with the internet: git, gh, node, npm, pnpm, python3, gcc, make, unzip, nix, builds, tests, subshells, $(...), env assignments.",
  "The container has no bun, Rust, or Go: run `nix develop -c <command>` when the repository has a flake.nix, or `nix shell nixpkgs#<package> -c <command>` otherwise.",
  "Run builds, tests, and installs under /tmp, never in /workspace.",
  "isolate: ask for the isolate; a command it cannot run goes to the container instead, except git, which is refused there.",
  "container: always the container.",
  "Both see the same workspace files.",
].join(" ");

const bash = createBashTool();

const parameters = obj(
  {
    command: str({ description: "Bash command to execute" }),
    timeout: opt(
      num({
        description: `Timeout in seconds (optional). A command is killed at its timeout or at ${LIMIT_SECONDS} s, whichever comes first.`,
      }),
    ),
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

function timeoutMessage(timeout: number | undefined, elapsedMs: number): string {
  const elapsed = `${Math.round(elapsedMs / 1_000)} s`;

  return timeout === undefined || timeout >= LIMIT_SECONDS
    ? `killed at the ${LIMIT_SECONDS} s limit after ${elapsed}`
    : `killed at your ${timeout} s timeout after ${elapsed}; the limit is ${LIMIT_SECONDS} s; rerun with a longer timeout`;
}

type TimedOut = { message?: string };

function watchTimeout<Api extends ToolExecutionApi>(
  api: Api,
  timeout: number | undefined,
  timedOut: TimedOut,
): Api {
  const { env } = api;

  if (!isComputerEnv(env)) return api;

  const exec: ExecutionEnv["exec"] = async (command, options, context) => {
    const started = Date.now();
    const result = await env.exec(command, options, context);

    if (!result.ok && result.error.code === "timeout") {
      timedOut.message = timeoutMessage(timeout, Date.now() - started);
    }

    return result;
  };

  return { ...api, env: { ...env, exec } };
}

const backendBash = defineTool({
  name: bash.name,
  description: bash.description,
  structuredOutputSchema: bash.structuredOutputSchema ?? {},
  outputLimits: bash.outputLimits ?? {},
  parameters,
  execute: async (args, api, context) => {
    const routed = args.backend === undefined ? api : onBackend(api, args.backend);
    const timedOut: TimedOut = {};

    try {
      return await bash.execute(args, watchTimeout(routed, args.timeout, timedOut), context);
    } catch (error) {
      throw timedOut.message === undefined ? error : new Error(timedOut.message);
    }
  },
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
