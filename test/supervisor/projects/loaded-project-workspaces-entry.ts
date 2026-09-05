/// <reference types="@cloudflare/workers-types" />

import { WorkerEntrypoint } from "cloudflare:workers";
import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import {
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
} from "../../workspace/project/fakes.js";
import { GitDiffExecBackend } from "../../facet/generation-0/git-diff-exec-backend.js";

/**
 * Test-only stand-in for the Workspace Host namespace, living in its own Worker Loader isolate.
 *
 * It exists because the local runtime cannot construct the real `WorkspaceHost` Durable Object at
 * all: its constructor builds a `WorkspaceContainerAPI`, which throws "DO is not container-enabled"
 * because `@cloudflare/vitest-plugin` provides no container. What this entrypoint reproduces is
 * the one thing the isolation property rests on — a name selects a filesystem, and two different
 * names select two different filesystems, with no shared state between them.
 *
 * Being a separate isolate is the point. A capability handed out here is a real cross-isolate RPC
 * stub, so a caller that obtains one and forwards it to a third isolate exercises the same
 * serialization, duplication, and disposal the deployed path does.
 */

// Module scope, not instance state: a `WorkerEntrypoint` is constructed per RPC call, so a
// workspace kept on `this` would vanish between the write call and the read call.
const workspaces = new Map<string, FakeProjectFilesystemProvider>();

function workspaceFor(name: string): FakeProjectFilesystemProvider {
  const existing = workspaces.get(name);
  if (existing !== undefined) {
    return existing;
  }

  const created = new FakeProjectFilesystemProvider();
  workspaces.set(name, created);
  return created;
}

export default class LoadedProjectWorkspacesEntry extends WorkerEntrypoint {
  /** The project capability for one workspace name, as `WorkspaceHost.project()` hands it out. */
  project(name: string): ProjectRpcTarget {
    const provider = workspaceFor(name);
    // A turn asks its workspace for a diff when it ends, and this backend answers that command by
    // diffing the files the turn wrote here rather than by replaying a scripted string.
    return new ProjectRpcTarget(
      provider,
      new FakeProjectTransactions(),
      new GitDiffExecBackend(provider),
    );
  }

  /**
   * Reads a file straight from one named workspace, without going through the capability under
   * test, so an isolation check cannot be satisfied by the same code path it is checking.
   */
  fileText(name: string, path: string): string | null {
    const workspace = workspaces.get(name);
    if (workspace === undefined) {
      return null;
    }

    try {
      return new TextDecoder().decode(workspace.readFileSync(path));
    } catch {
      return null;
    }
  }

  /** The names this isolate has been asked for, so a test can see how many workspaces exist. */
  requestedNames(): string[] {
    return [...workspaces.keys()].toSorted();
  }
}
