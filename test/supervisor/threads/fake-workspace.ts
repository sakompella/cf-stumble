import type { ProjectResult, WorkspaceResult } from "../../../src/workspace/index.js";

export type FakeWorkspaceOptions = Readonly<{ files?: Readonly<Record<string, string>> }>;

/**
 * A workspace capability with the Workspace Host's own RPC surface: `build`, `provision`, and
 * `project`. Every call is recorded, so a test can hold that a code path made no workspace call at
 * all rather than that no call it made happened to break anything.
 *
 * A turn reaches the workspace's files through the project capability (ADR-0037), so that is
 * where this fake keeps them. No test in this directory runs a build or a provision, so those two
 * surfaces record the call and then fail rather than inventing an answer.
 */
export class FakeWorkspace {
  readonly requests: string[] = [];
  readonly files = new Map<string, string>();

  constructor(options: FakeWorkspaceOptions = {}) {
    for (const [path, content] of Object.entries(options.files ?? {})) {
      this.files.set(path, content);
    }
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Mirrors the Workspace Host's RPC boundary.
  build(request: unknown): Promise<WorkspaceResult> {
    this.requests.push(`build:${JSON.stringify(request)}`);

    return Promise.reject(new Error("no thread test builds a harness commit"));
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Mirrors the Workspace Host's RPC boundary.
  provision(request: unknown): Promise<WorkspaceResult> {
    this.requests.push(`provision:${JSON.stringify(request)}`);

    return Promise.reject(new Error("no thread test provisions a project"));
  }

  project(): FakeProjectCapability {
    this.requests.push("project");

    return new FakeProjectCapability(this.files, this.requests);
  }
}

/**
 * The one method a thread test needs from the capability `project` hands out. It takes text
 * rather than the real target's bytes and write mode: what a thread test holds is that a call
 * happened and what it left in the workspace, not how the content was encoded.
 */
export class FakeProjectCapability {
  readonly #files: Map<string, string>;
  readonly #requests: string[];

  constructor(files: Map<string, string>, requests: string[]) {
    this.#files = files;
    this.#requests = requests;
  }

  writeFile(path: string, content: string): Promise<ProjectResult<null>> {
    this.#requests.push(`write-file:${path}`);
    this.#files.set(path, content);

    return Promise.resolve({ ok: true, value: null });
  }
}
