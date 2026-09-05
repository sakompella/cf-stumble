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
import { WORKSPACE_ROOT } from "../workspace-layout.js";

// Version 0 has one check command, so it is fixed here rather than configurable. The root is the
// workspace root that `workspace-layout.ts` owns, the same one the project capability addresses
// paths beneath, so this surface and that one cannot disagree about where the repositories are.
const CONFIGURATION = {
  root: WORKSPACE_ROOT,
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
 * The one durable Computer workspace a tenant owns (ADR-0038). It holds the harness repository,
 * every connected project repository, and the build scratch subtree as separate directories, and
 * the Supervisor names it from its own server-derived tenant key.
 *
 * Its RPC surface returns plain values and one narrow project capability; it never returns the
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
   * Build one labeled harness commit. This surface carries only the planned build steps, so a
   * caller names a commit and a step and never supplies command text. A build extracts into the
   * scratch subtree `workspace-layout.ts` reserves for it, which holds no repository, so a build
   * writes inside no project clone and never inside the editable harness checkout.
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
   * A caller names a project and a planned step. The repository URL and the directory are both
   * resolved from the catalog on this side, so no caller can point a clone at a URL or a place of
   * its own.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Durable Object RPC input is untrusted.
  provision(request: unknown): Promise<WorkspaceResult> {
    return executeProjectProvisionRequest({
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
