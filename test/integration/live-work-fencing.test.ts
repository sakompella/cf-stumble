/// <reference types="@cloudflare/vitest-plugin/types" />
// oxlint-disable import/max-dependencies -- A turn across the Worker, the Supervisor, a loaded generation, and a capability names each piece it runs.

import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import type { ProjectCapabilityStub } from "../../src/supervisor/projects/index.js";
import { ProjectRpcTarget } from "../../src/workspace/project/index.js";
import type { WorkspaceResetResult } from "../../src/workspace/index.js";
import { sampleProjectOne } from "../project-fixtures.js";
import { FakeTenantWorkspace } from "../supervisor/projects/fake-tenant-workspace.js";
import { connectSampleProjects } from "../supervisor/helpers.js";
import { THREAD_MESSAGE_SAMPLES } from "../supervisor/threads/message-samples.js";
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

/**
 * A second browser tab, or any other owner API client, asks for a fresh thread or a workspace
 * reset while the first tab's turn is running a command. The page disables its own fresh button
 * while it streams a turn, but that guards only the tab that streams; this sends both requests
 * through the Worker as a second client would.
 *
 * The Worker, the Supervisor, its thread store, and a loaded generation are real. The generation
 * starts one command through its project capability and waits for it, as a turn running `sleep 90`
 * does. The capability is the real `ProjectRpcTarget` over an exec backend the test answers, and
 * the Workspace Host around it is the fake in `fake-tenant-workspace.ts`.
 */

const generationSource = `
import { DurableObject } from "cloudflare:workers";

const user = ${JSON.stringify(THREAD_MESSAGE_SAMPLES.user)};
const assistant = ${JSON.stringify(THREAD_MESSAGE_SAMPLES.assistant)};

export class MainFacet extends DurableObject {
  fetch() {
    return new Response("ready");
  }

  startTurn(capability, request) {
    const kept = capability.dup();
    const encoder = new TextEncoder();
    const line = (frame) => encoder.encode(JSON.stringify(frame) + "\\n");

    return new ReadableStream({
      async start(controller) {
        const started = await kept.startExec({ command: "sleep 90" });
        controller.enqueue(line({ kind: "text", text: started.ok ? "command running" : "refused" }));

        if (started.ok) await new Response(started.value.events).arrayBuffer();

        kept[Symbol.dispose]();
        controller.enqueue(line({ kind: "completed", state: { messages: [...request.messages, user, assistant] } }));
        controller.close();
      },
    });
  }
}
`;

/** The fake Workspace Host, with a real capability whose commands the test answers. */
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

    // Workers RPC gives the generation a real stub. The Supervisor's own duplicate is the target.
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

async function readUntil(reader: ReadableStreamDefaultReader<string>, text: string) {
  let read = "";

  while (!read.includes(text)) {
    const chunk = await reader.read();

    if (chunk.done) throw new Error(`the turn ended before it wrote ${text}: ${read}`);

    read += chunk.value;
  }
}

test("a second client cannot start a fresh thread or reset the workspace under a running command", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const workspace = stubExternalBoundaries(new LiveWorkWorkspace());
  const owner = await ownerSession("integration-live-work-fencing");
  await servingScriptedGeneration(owner, generationSource);
  await connectSampleProjects(owner.supervisor);
  const projectPath = `/api/projects/${sampleProjectOne.id}`;

  const firstTab = await owner.post(`${projectPath}/turn`, { prompt: "run the command" });

  expect(firstTab.status).toBe(200);
  const reader = firstTab.body?.pipeThrough(new TextDecoderStream()).getReader();

  if (reader === undefined) throw new Error("the turn must stream");

  await readUntil(reader, "command running");

  const fresh = await owner.post(`${projectPath}/thread/fresh`);
  const resetWorkspace = await owner.post("/api/workspace/reset");

  expect(fresh.status).toBe(409);
  await expect(fresh.json()).resolves.toMatchObject({
    ok: false,
    problem: { code: "turn-active", projectId: sampleProjectOne.id },
  });
  expect(resetWorkspace.status).toBe(409);
  await expect(resetWorkspace.json()).resolves.toMatchObject({
    ok: false,
    problem: { code: "turn-active", projectId: sampleProjectOne.id },
  });
  expect(workspace.resets, "the Workspace Host was never asked to reset").toBe(0);
  expect(workspace.execBackend.handles[0]?.killCalls, "the command was left running").toBe(0);

  // The command's handle belongs to the Supervisor's context, so it is answered from there.
  await runInDurableObject(owner.supervisor, () => {
    workspace.execBackend.handles[0]?.push({ name: "exit", exitCode: 0 });
  });
  await readUntil(reader, '"saved"');

  const freshAfter = await owner.post(`${projectPath}/thread/fresh`);
  const resetAfter = await owner.post("/api/workspace/reset");

  expect(freshAfter.status).toBe(200);
  await expect(freshAfter.json()).resolves.toMatchObject({ ok: true, thread: { messageCount: 0 } });
  expect(resetAfter.status).toBe(200);
  expect(workspace.resets).toBe(1);
});
