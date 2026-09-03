/// <reference types="@cloudflare/workers-types" />

import { Workspace, type DurableObjectStorageLike } from "@cloudflare/computer";
import {
  CloudflareContainerBackend,
  WorkspaceContainerAPI,
} from "@cloudflare/computer/backends/container";
import { DurableObject } from "cloudflare:workers";
import type { WorkspaceConfiguration, WorkspaceResult } from "./decisions.js";
import { ComputerWorkspaceOperations } from "./computer-operations.js";
import { executeHarnessBuildRequest, executeWorkspaceRequest } from "./executor.js";
import { HARNESS_BUILD_CONFIGURATION } from "../harness-build.js";

const PROJECT_ROOT = "/project";

// Version 0 has one project and one check command, so both are fixed here rather than configurable.
const CONFIGURATION = {
  root: PROJECT_ROOT,
  commands: { check: "./test.sh" },
} as const satisfies WorkspaceConfiguration;

interface WorkspaceHostEnv {}

function computerStorage(storage: DurableObjectStorage): DurableObjectStorageLike {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Computer 0.3.0 accepts the same Durable Object SQLite API; its generic cursor declaration is narrower than @cloudflare/workers-types.
  return storage as DurableObjectStorageLike;
}

/**
 * Durable, tenant-scoped Computer host. Its RPC surface returns values only; it never returns the
 * workspace, its container API, or a credential-bearing binding.
 */
export class WorkspaceHost extends DurableObject<WorkspaceHostEnv> {
  readonly #workspace: Workspace;
  readonly #containerBackend: CloudflareContainerBackend;

  constructor(ctx: DurableObjectState, env: WorkspaceHostEnv) {
    super(ctx, env);
    const container = new WorkspaceContainerAPI(ctx);
    this.#containerBackend = new CloudflareContainerBackend({
      container: () => ({ getWorkspaceContainer: () => container }),
      workspace: { binding: "WORKSPACE_HOST", id: ctx.id.toString() },
      egress: { mode: "none" },
    });
    this.#workspace = new Workspace({
      storage: computerStorage(ctx.storage),
      sessionId: ctx.id.toString(),
      backends: [this.#containerBackend],
    });
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Durable Object RPC input is untrusted.
  execute(request: unknown): Promise<WorkspaceResult> {
    return executeWorkspaceRequest({
      configuration: CONFIGURATION,
      operations: new ComputerWorkspaceOperations(this.#workspace),
      request,
    });
  }

  /**
   * Build one labeled harness commit. This surface has its own root and only the planned build
   * steps, so a caller names a commit and a step and never supplies command text. A build
   * workspace is a separate Workspace Host instance, so a build reaches no project file even
   * though one class serves both surfaces.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Durable Object RPC input is untrusted.
  build(request: unknown): Promise<WorkspaceResult> {
    return executeHarnessBuildRequest({
      configuration: HARNESS_BUILD_CONFIGURATION,
      operations: new ComputerWorkspaceOperations(this.#workspace),
      request,
    });
  }

  override fetch(request: Request): Promise<Response> {
    return this.#containerBackend.handleFetch(request);
  }
}
