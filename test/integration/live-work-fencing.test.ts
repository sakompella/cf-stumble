import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import type { ProjectCapabilityStub } from "../../src/supervisor/projects/index.js";
import { ProjectRpcTarget } from "../../src/workspace/project/index.js";
import type { WorkspaceResetResult } from "../../src/workspace/index.js";
import { sampleProjectOne } from "../project-fixtures.js";
import { FakeTenantWorkspace } from "../supervisor/projects/fake-tenant-workspace.js";
import {
  ANSWER_STARTUP_CHECK,
  FACET_COMPATIBILITY_METHOD,
  STARTUP_CHECK_CONVERSATION,
} from "../supervisor/helpers.js";
import {
  FakeExecBackend,
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
} from "../workspace/project/fakes.js";
import {
  ownerSession,
  servingScriptedGeneration,
  stubExternalBoundaries,
} from "./owner-session.js";

const generationSource = `
import { DurableObject } from "cloudflare:workers";

export class MainFacet extends DurableObject {
  ${FACET_COMPATIBILITY_METHOD}
  fetch() {
    return new Response("ready");
  }

  async attach(host) {
    this.host ??= host.dup();
  }

  async createConversation(cwd) {
    return "conversation:" + cwd;
  }

  async submit(conversationId) {
    if (conversationId === ${JSON.stringify(STARTUP_CHECK_CONVERSATION)}) return "startup check";
    await this.host.running([conversationId]);
    await this.host.arm({ active: true });
    this.run = (async () => {
      const capability = await this.host.workspace(conversationId);
      const started = await capability.startExec({ command: "sleep 90" });

      if (started.ok) await new Response(started.value.events).arrayBuffer();

      await this.host.running([]);
      await this.host.arm({ active: false });
    })();

    return "submission";
  }

  async events(conversationId) {
    ${ANSWER_STARTUP_CHECK}
  }
}
`;

class LiveWorkWorkspace extends FakeTenantWorkspace {
  readonly execBackend = new FakeExecBackend();
  resets = 0;

  project(budget: Readonly<{ remainingMs: number }>): Promise<ProjectCapabilityStub> {
    const target = new ProjectRpcTarget(
      new FakeProjectFilesystemProvider(),
      new FakeProjectTransactions(),
      this.execBackend,
      budget,
    );

    const held = Object.assign(target, { [Symbol.dispose]: () => {} });

    return Promise.resolve(Object.assign(held, { dup: () => held }));
  }

  reset(): Promise<WorkspaceResetResult> {
    this.resets += 1;

    return Promise.resolve({ ok: true, reset: "workspace" });
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

function removals(workspace: FakeTenantWorkspace): readonly string[] {
  return workspace.commands.filter((command) => command.includes("rm -rf --"));
}

test("a second client cannot reset the workspace or disconnect the project under a running command", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const workspace = stubExternalBoundaries(new LiveWorkWorkspace());
  const owner = ownerSession();
  await servingScriptedGeneration(owner, generationSource);
  const projectPath = `/api/projects/${sampleProjectOne.id}`;

  const connected = await owner.post("/api/projects/connect", {
    repositoryUrl: sampleProjectOne.repositoryUrl,
  });

  expect(connected.status).toBe(200);

  const submitted = await owner.post(`${projectPath}/messages`, {
    content: "run the command",
    requestId: "first-tab",
  });

  expect(submitted.status).toBe(202);
  await vi.waitFor(() => {
    expect(workspace.execBackend.handles).toHaveLength(1);
  });

  const resetWorkspace = await owner.post("/api/workspace/reset");
  const disconnect = await owner.post(`${projectPath}/disconnect`);

  expect(resetWorkspace.status).toBe(409);
  await expect(resetWorkspace.json()).resolves.toMatchObject({ problem: { code: "run-active" } });
  expect(disconnect.status).toBe(409);
  await expect(disconnect.json()).resolves.toMatchObject({ problem: { code: "run-active" } });
  expect(workspace.resets, "the Workspace Host was never asked to reset").toBe(0);
  expect(removals(workspace), "a running command's working tree must not be deleted").toEqual([]);
  expect(workspace.execBackend.handles[0]?.killCalls, "the command was left running").toBe(0);

  await runInDurableObject(owner.supervisor, () => {
    workspace.execBackend.handles[0]?.push({ name: "exit", exitCode: 0 });
  });

  await vi.waitFor(async () => {
    expect((await owner.post(`${projectPath}/disconnect`)).status).toBe(200);
  });
  expect(removals(workspace)).toHaveLength(1);
  expect((await owner.post("/api/workspace/reset")).status).toBe(200);
  expect(workspace.resets).toBe(1);
});
