import type {
  ModelCapability,
  WorkspaceCapability,
} from "../../../src/facet/generation-0/index.js";
import type {
  ModelRouteRequest,
  ModelRouteResponse,
  ValidationFailure,
} from "../../../src/model-route.js";
import type { WorkspaceRequest, WorkspaceResult } from "../../../src/workspace/index.js";

export type FakeModelReply = ModelRouteResponse | ValidationFailure;

/** A model route that answers from a fixed script and records exactly what the facet sent it. */
export class FakeModelRoute implements ModelCapability {
  readonly requests: ModelRouteRequest[] = [];
  private readonly replies: FakeModelReply[];

  constructor(replies: readonly FakeModelReply[]) {
    this.replies = [...replies];
  }

  run(request: ModelRouteRequest): Promise<FakeModelReply> {
    this.requests.push(request);
    const reply = this.replies.shift();
    return reply === undefined
      ? Promise.reject(new Error("the fake model route ran out of scripted replies"))
      : Promise.resolve(reply);
  }
}

export type FakeWorkspaceOptions = Readonly<{
  files?: Readonly<Record<string, string>>;
  commands?: Readonly<
    Record<string, Readonly<{ stdout: string; stderr: string; exitCode: number }>>
  >;
  entries?: readonly string[];
  refuse?: Readonly<{
    kind: WorkspaceRequest["kind"];
    code: "path-outside-root" | "unknown-command";
  }>;
  reject?: WorkspaceRequest["kind"];
}>;

const DIFF = "diff --git a/src/app.ts b/src/app.ts\n";

/**
 * A workspace capability with the Workspace Host's own RPC surface. `refuse` returns the plain
 * failure the host returns for a refused request; `reject` throws, which is what a lost Durable
 * Object or a broken Computer call looks like from inside the facet.
 */
export class FakeWorkspace implements WorkspaceCapability {
  readonly requests: WorkspaceRequest[] = [];
  readonly files = new Map<string, string>();
  private readonly options: FakeWorkspaceOptions;

  constructor(options: FakeWorkspaceOptions = {}) {
    this.options = options;
    for (const [path, content] of Object.entries(options.files ?? {})) {
      this.files.set(path, content);
    }
  }

  execute(request: WorkspaceRequest): Promise<WorkspaceResult> {
    this.requests.push(request);
    if (this.options.reject === request.kind) {
      return Promise.reject(new Error("fake workspace failure"));
    }
    const refuse = this.options.refuse;
    if (refuse !== undefined && refuse.kind === request.kind) {
      return Promise.resolve({ ok: false, error: { code: refuse.code } });
    }

    return Promise.resolve(this.answer(request));
  }

  private answer(request: WorkspaceRequest): WorkspaceResult {
    switch (request.kind) {
      case "read-file": {
        const content = this.files.get(request.path);
        return content === undefined
          ? { ok: false, error: { code: "workspace-unavailable" } }
          : { ok: true, result: { kind: "file", content } };
      }
      case "write-file":
        this.files.set(request.path, request.content);
        return { ok: true, result: { kind: "written" } };
      case "list-files":
        return { ok: true, result: { kind: "files", entries: this.options.entries ?? [] } };
      case "run-command": {
        const output = this.options.commands?.[request.command];
        return output === undefined
          ? { ok: false, error: { code: "unknown-command" } }
          : { ok: true, result: { kind: "command", ...output } };
      }
      case "git-diff":
        return { ok: true, result: { kind: "git-diff", stdout: DIFF, stderr: "", exitCode: 0 } };
      default: {
        const exhaustive: never = request;
        return exhaustive;
      }
    }
  }
}

export type ScriptedToolCall = Readonly<{
  id: string;
  name: string;
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Tool arguments are an open JSON object, exactly as the model route reports them.
  arguments: Readonly<Record<string, unknown>>;
}>;

export function toolCallReply(calls: readonly ScriptedToolCall[]): ModelRouteResponse {
  return {
    ok: true,
    message: {
      role: "assistant",
      content: null,
      tool_calls: calls.map((call) => ({
        id: call.id,
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    },
  };
}

export function textReply(text: string): ModelRouteResponse {
  return { ok: true, message: { role: "assistant", content: text, tool_calls: [] } };
}

export const modelUnavailableReply: ModelRouteResponse = {
  ok: false,
  error: { code: "model-unavailable" },
};

/** The text a tool result carried back to the model, for the request the facet sent next. */
export function toolResultTexts(request: ModelRouteRequest): readonly string[] {
  return request.messages
    .filter((message) => message.role === "tool")
    .map((message) => (message.role === "tool" ? message.content : ""));
}
