import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { storeGrant } from "../../chatgpt/connection-harness.js";
import type { Entry } from "../../../src/page/client/pi-message.js";
import { builtGeneration } from "../../facet/generation-1/built-module-map.js";
import { replaceWorkspaceHost } from "../../workspace-host-spy.js";
import {
  activateGeneration,
  connectedSupervisor,
  prepareWithModuleMap,
  submitCandidate,
} from "../helpers.js";
import { answerCount, lines, openReader, type Line } from "./generation-1-transcript.js";
import type { ProjectWorkspace } from "./project-workspace.js";
import type { WorkspaceHostRpc } from "../../../src/workspace/host-rpc.js";

type Control = Awaited<ReturnType<typeof connectedSupervisor>>;

export async function commitNamed(name: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(name));

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function grantedSupervisor(
  name: string,
  workspace: ProjectWorkspace,
): Promise<Control> {
  replaceWorkspaceHost<Omit<WorkspaceHostRpc, "reset" | "backend" | "setBackend">>(
    env.WORKSPACE_HOST,
    workspace,
  );

  const control = await connectedSupervisor(name);

  await runInDurableObject(control, (_instance, state) => {
    storeGrant(state.storage, {
      accessToken: "chatgpt-access-FAKE-generation-1",
      refreshToken: "chatgpt-refresh-FAKE-generation-1",
      expiresAt: Date.now() + 3_600_000,
      clientId: "oaiapp_FAKEclient",
    });
  });

  return control;
}

export async function servingGeneration1(
  name: string,
  workspace: ProjectWorkspace,
): Promise<Control> {
  const control = await grantedSupervisor(name, workspace);
  const commit = await commitNamed(name);
  const label = await submitCandidate(control, commit);
  const checked = await prepareWithModuleMap(control, label, await builtGeneration(commit));

  if (!checked.ok || checked.report.stage !== "ready") {
    throw new Error("the built generation must pass its startup check");
  }

  workspace.leases.splice(0);
  await activateGeneration(control, label);

  return control;
}

export async function submitted(
  control: Control,
  projectId: string,
  content: string,
  requestId: string,
): Promise<number> {
  const result = await control.submitProjectMessage(projectId, content, requestId, 30);

  if (!result.ok) throw new Error(`the message must be admitted: ${result.problem.code}`);

  return result.submissionId;
}

type EventsView = ReturnType<typeof openReader>;

async function readEventsUntil(
  control: Control,
  projectId: string,
  done: (view: EventsView) => boolean,
): Promise<EventsView> {
  const opened = await control.projectEvents(projectId);

  if (!opened.ok) throw new Error(`the events must open: ${opened.problem.code}`);
  const reader = opened.events.pipeThrough(new TextDecoderStream()).getReader();
  const view = openReader();
  let buffer = "";

  try {
    while (!done(view)) {
      const next = await reader.read();

      if (next.done) throw new Error("the event stream ended before the awaited view arrived");
      const split = (buffer + next.value).split("\n");
      buffer = split.pop() ?? "";

      for (const line of split.filter((received) => received !== "")) view.feed(line);
    }
  } finally {
    await reader.cancel();
  }

  return view;
}

export async function untilAnswered(
  control: Control,
  projectId: string,
  count: number,
): Promise<readonly Entry[]> {
  const view = await readEventsUntil(
    control,
    projectId,
    (read) => answerCount(read.entries()) >= count,
  );

  return view.entries();
}

export async function answeredLines(
  control: Control,
  projectId: string,
  count: number,
): Promise<readonly Line[]> {
  return lines(await untilAnswered(control, projectId, count));
}

export async function hasRun(control: Control, projectId: string): Promise<boolean> {
  const view = await readEventsUntil(control, projectId, (read) => read.viewed());

  return view.isRunning();
}

export async function untilIdle(control: Control, projectId: string): Promise<void> {
  await readEventsUntil(control, projectId, (read) => read.viewed() && !read.isRunning());
}
