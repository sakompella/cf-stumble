/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";
import { FakeWorkspace } from "../../facet/generation-0/fakes.js";
import { THREAD_MESSAGE_SAMPLES } from "./message-samples.js";

const NOW = 1_700_000_000_000;
const LEASE_MS = 30_000;

const savedConversation = [
  THREAD_MESSAGE_SAMPLES.user,
  THREAD_MESSAGE_SAMPLES.assistant,
  THREAD_MESSAGE_SAMPLES.toolResult,
  THREAD_MESSAGE_SAMPLES.compactionSummary,
];

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

/**
 * A project workspace holding what a turn wrote into it.
 *
 * The workspace is a fake because a Computer container cannot run under `workerd`, but the thing
 * this test holds is not the container: it is that starting a fresh thread reaches nothing but
 * thread storage. A fake records every call, so "the files survived" is checked as "the reset made
 * no workspace call at all" rather than as "no call happened to break anything".
 */
async function workspaceWithTurnOutput(): Promise<FakeWorkspace> {
  const workspace = new FakeWorkspace({ files: { "/project/notes.md": "written before" } });
  await workspace.execute({
    kind: "write-file",
    path: "/project/plan.md",
    content: "the agent wrote this during a turn",
  });
  return workspace;
}

function sortedFiles(workspace: FakeWorkspace): readonly (readonly [string, string])[] {
  return [...workspace.files.entries()].toSorted(([left], [right]) => left.localeCompare(right));
}

async function threadWithConversation(
  control: DurableObjectStub<Supervisor>,
  projectId: string,
): Promise<void> {
  const started = await control.startProjectTurn(projectId, 0, NOW, LEASE_MS);
  const finished = await control.finishProjectTurn(projectId, 0, savedConversation, NOW);
  if (!started.ok || !finished.ok) {
    throw new Error(`the ${projectId} thread must accept a first turn`);
  }
}

test("starting a fresh thread removes the conversation and leaves the workspace files alone", async () => {
  const control = supervisor("fresh-thread");
  const workspace = await workspaceWithTurnOutput();
  await threadWithConversation(control, "project-one");
  const filesBefore = sortedFiles(workspace);
  const callsBefore = workspace.requests.length;

  const fresh = await control.startFreshProjectThread("project-one");
  const after = await control.getProjectThread("project-one");

  // The project's files are exactly what the turn left behind, and the reset asked the workspace
  // for nothing: a fresh thread replaces the conversation, not the machine it ran on (ADR-0038).
  expect(sortedFiles(workspace)).toEqual(filesBefore);
  expect(workspace.requests.length, "a fresh thread must not call the workspace").toBe(callsBefore);

  // The conversation is gone. A reset that wrote nothing would pass the two assertions above.
  expect(fresh).toEqual({
    ok: true,
    thread: {
      projectId: "project-one",
      conversation: "[]",
      messageCount: 0,
      revision: 0,
      turnActive: false,
      turnDeadlineAt: undefined,
    },
  });
  expect(after).toEqual(fresh);
});

test("a fresh thread frees the turn slot the replaced conversation held", async () => {
  const control = supervisor("fresh-thread-releases-turn");
  await threadWithConversation(control, "project-one");
  const held = await control.startProjectTurn("project-one", 1, NOW, LEASE_MS);

  await control.startFreshProjectThread("project-one");

  // The turn that was running cannot commit into the thread it no longer holds, and the next turn
  // starts from the fresh thread's revision rather than waiting for the old lease to expire.
  const lateFinish = await control.finishProjectTurn("project-one", 1, savedConversation, NOW);
  const restarted = await control.startProjectTurn("project-one", 0, NOW, LEASE_MS);

  expect(held).toMatchObject({ ok: true, thread: { turnActive: true } });
  expect(lateFinish).toEqual({
    ok: false,
    problem: { code: "turn-not-active", projectId: "project-one" },
  });
  expect(restarted).toMatchObject({ ok: true, thread: { conversation: "[]", revision: 0 } });
});

test("a fresh thread for one project leaves the other project's thread alone", async () => {
  const control = supervisor("fresh-thread-one-project");
  await threadWithConversation(control, "project-one");
  await threadWithConversation(control, "project-two");

  await control.startFreshProjectThread("project-one");

  expect(await control.getProjectThread("project-one")).toMatchObject({
    ok: true,
    thread: { conversation: "[]", messageCount: 0, revision: 0 },
  });
  expect(await control.getProjectThread("project-two")).toMatchObject({
    ok: true,
    thread: { conversation: JSON.stringify(savedConversation), revision: 1 },
  });
});

test("a fresh thread is refused for a project the catalog does not have", async () => {
  const control = supervisor("fresh-thread-unknown-project");

  expect(await control.startFreshProjectThread("project-nine")).toEqual({
    ok: false,
    problem: { code: "unknown-project-id" },
  });
});

afterEach(async () => {
  await reset();
});
