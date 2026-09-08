/// <reference types="@cloudflare/workers-types" />

import { Workspace, type DurableObjectStorageLike } from "@cloudflare/computer";
import {
  CloudflareContainerBackend,
  type CloudflareContainerBackendOptions,
  WorkspaceContainerAPI,
} from "@cloudflare/computer/backends/container";
import { DurableObject } from "cloudflare:workers";
import type { WorkspaceResult } from "./decisions.js";
import { ComputerWorkspaceOperations } from "./computer-operations.js";
import { executeHarnessBuildRequest, executeProjectProvisionRequest } from "./executor.js";
import {
  executeGitHubCredentialRequest,
  type GitHubCredentialResult,
} from "./github-credential.js";
import {
  computerExecBackend,
  computerFilesystemProvider,
  computerTransactions,
  ProjectRpcTarget,
} from "./project/index.js";
import { harnessBuildConfiguration } from "../harness-build.js";

interface WorkspaceHostEnv {
  /** The harness repository this deployment builds from. See `harness-build.ts`. */
  readonly HARNESS_REPOSITORY_URL?: string;
}

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

  /**
   * Build one labeled harness commit. This surface carries only the planned build steps, so a
   * caller names a commit and a step and never supplies command text. A build extracts into the
   * scratch subtree `workspace-layout.ts` reserves for it, which holds no repository, so a build
   * writes inside no project clone and never inside the editable harness checkout.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Durable Object RPC input is untrusted.
  build(request: unknown): Promise<WorkspaceResult> {
    return executeHarnessBuildRequest({
      configuration: harnessBuildConfiguration(this.env.HARNESS_REPOSITORY_URL),
      operations: new ComputerWorkspaceOperations(this.#workspace),
      request,
    });
  }

  /**
   * Reconcile this workspace against the repository the catalog names for a project, and rewrite
   * the managed agent instructions.
   *
   * This is a surface of its own rather than a step of the build surface. Each surface parses
   * only its own request and plans from its own configuration, so a build can never reach a
   * project clone and a provision can never reach the harness build root.
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
   * Install, inspect, or exercise this workspace's GitHub credential.
   *
   * This is where a token enters the workspace and stops. The install writes it to a private
   * staging file outside every repository, `gh` reads it from there, and the command deletes it;
   * from then on the credential lives in the ordinary local `gh` configuration and Git's helper
   * reads it (ADR-0039). Nothing this surface returns carries a token: an install answers with a
   * word, a status with a state and at most a login name, and a failure with redacted text.
   *
   * It is a surface of its own for the same reason provisioning is: a credential install is
   * neither a build step nor a provisioning step, and each surface parses only its own request,
   * so neither of the others can be asked to install, read, or exercise a token.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Durable Object RPC input is untrusted.
  credential(request: unknown): Promise<GitHubCredentialResult> {
    return executeGitHubCredentialRequest({
      operations: new ComputerWorkspaceOperations(this.#workspace),
      request,
    });
  }

  /**
   * Hand out this workspace's project capability. `build` and `provision` each answer one request
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
