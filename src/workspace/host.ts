/// <reference types="@cloudflare/workers-types" />

import { Workspace, type DurableObjectStorageLike } from "@cloudflare/computer";
import {
  CloudflareContainerBackend,
  type CloudflareContainerBackendOptions,
  WorkspaceContainerAPI,
} from "@cloudflare/computer/backends/container";
import { DurableObject } from "cloudflare:workers";
import type { WorkspaceConfiguration, WorkspaceResult } from "./decisions.js";
import { ComputerWorkspaceOperations } from "./computer-operations.js";
import {
  executeHarnessBuildRequest,
  executeProjectProvisionRequest,
  executeWorkspaceRequest,
} from "./executor.js";
import {
  computerExecBackend,
  computerFilesystemProvider,
  computerTransactions,
  ProjectRpcTarget,
} from "./project/index.js";
import { HARNESS_BUILD_CONFIGURATION } from "../harness-build.js";
import { PROJECT_PROVISION_CONFIGURATION } from "../project-provision.js";

// Version 0 has one check command, so it is fixed here rather than configurable. The root comes
// from the provisioning configuration because the clone lands there: two constants would let the
// surface Pi reads and the directory the repository is cloned into drift apart.
const CONFIGURATION = {
  root: PROJECT_PROVISION_CONFIGURATION.projectRoot,
  commands: { check: "./test.sh" },
} as const satisfies WorkspaceConfiguration;

interface WorkspaceHostEnv {}

export function workspaceContainerBackendConfiguration(
  workspaceId: string,
): Pick<CloudflareContainerBackendOptions, "egress" | "workspace"> {
  return {
    workspace: { binding: "WORKSPACE_HOST", id: workspaceId },
    egress: { mode: "direct" },
  };
}

function computerStorage(storage: DurableObjectStorage): DurableObjectStorageLike {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Computer 0.3.0 accepts the same Durable Object SQLite API; its generic cursor declaration is narrower than @cloudflare/workers-types.
  return storage as DurableObjectStorageLike;
}

/**
 * Durable, tenant-scoped Computer host. Its RPC surface returns plain values and one narrow
 * project capability; it never returns the workspace, its container API, or a credential-bearing
 * binding.
 */
export class WorkspaceHost extends DurableObject<WorkspaceHostEnv> {
  readonly #workspace: Workspace;
  readonly #containerBackend: CloudflareContainerBackend;

  constructor(ctx: DurableObjectState, env: WorkspaceHostEnv) {
    super(ctx, env);
    const container = new WorkspaceContainerAPI(ctx);
    this.#containerBackend = new CloudflareContainerBackend({
      container: () => ({ getWorkspaceContainer: () => container }),
      ...workspaceContainerBackendConfiguration(ctx.id.toString()),
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

  /**
   * Reconcile this workspace against the repository the catalog names for a project, and rewrite
   * the managed agent instructions.
   *
   * This is a surface of its own rather than another `execute` command. `planWorkspaceRequest`
   * refuses any `run-command` whose name is not a key of the project configuration's `commands`,
   * and that map holds exactly the check the user's repository defines. Adding provisioning there
   * would put a clone within reach of whatever asks for a check.
   *
   * A caller names a project and a planned step. The repository URL is resolved from the catalog
   * on this side, so no caller can point a clone at a URL of its own.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Durable Object RPC input is untrusted.
  provision(request: unknown): Promise<WorkspaceResult> {
    return executeProjectProvisionRequest({
      configuration: PROJECT_PROVISION_CONFIGURATION,
      operations: new ComputerWorkspaceOperations(this.#workspace),
      request,
    });
  }

  /**
   * Hand out this workspace's project capability. `execute` and `build` each answer one request
   * and return plain values, which suits a caller that asks for one thing; a turn instead makes
   * many calls spread over its own lifetime, so this returns the narrow six-method surface once
   * and the caller holds it for the turn.
   *
   * The capability is a `ProjectRpcTarget`, which the runtime serializes only for an RPC call. It
   * can therefore only ever travel as a call argument or a return value, and never as a Worker
   * Loader environment entry, which is cached per harness commit and shared by every project the
   * generation serves.
   */
  project(): ProjectRpcTarget {
    return new ProjectRpcTarget(
      computerFilesystemProvider(this.#workspace),
      computerTransactions(this.#workspace),
      computerExecBackend(this.#workspace),
    );
  }

  override fetch(request: Request): Promise<Response> {
    return this.#containerBackend.handleFetch(request);
  }
}
