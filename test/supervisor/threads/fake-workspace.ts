import type { WorkspaceRequest, WorkspaceResult } from "../../../src/workspace/index.js";

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
export class FakeWorkspace {
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
