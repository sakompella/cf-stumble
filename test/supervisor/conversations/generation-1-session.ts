import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { ChatGPTCredentialStore } from "../../../src/chatgpt/index.js";
import type { SupervisorWorkspaceHost } from "../../../src/supervisor/supervisor-env.js";
import type { AgentEvent, Entry } from "../../../src/page/client/agent-event.js";
import { builtGeneration } from "../../facet/generation-1/built-module-map.js";
import { replaceWorkspaceHost } from "../../workspace-host-spy.js";
import {
  activateGeneration,
  connectedSupervisor,
  prepareWithModuleMap,
  submitCandidate,
} from "../helpers.js";
import { answerCount, lines, readEvent, transcript, type Line } from "./generation-1-transcript.js";
import type { ProjectWorkspace } from "./project-workspace.js";

type Control = Awaited<ReturnType<typeof connectedSupervisor>>;

async function commitNamed(name: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(name));

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function servingGeneration1(
  name: string,
  workspace: ProjectWorkspace,
): Promise<Control> {
  replaceWorkspaceHost<Omit<SupervisorWorkspaceHost, "reset">>(env.WORKSPACE_HOST, workspace);

  const control = await connectedSupervisor(name);

  await runInDurableObject(control, (_instance, state) => {
    new ChatGPTCredentialStore(state.storage).connect(
      {
        accessToken: "chatgpt-access-FAKE-generation-1",
        refreshToken: "chatgpt-refresh-FAKE-generation-1",
        expiresAt: Date.now() + 3_600_000,
        clientId: "oaiapp_FAKEclient",
      },
      Date.now(),
    );
  });

  const commit = await commitNamed(name);
  const label = await submitCandidate(control, commit);
  const checked = await prepareWithModuleMap(control, label, await builtGeneration(commit));

  if (!checked.ok || checked.report.stage !== "ready") {
    throw new Error("the built generation must pass its startup check");
  }

  await activateGeneration(control, label);

  return control;
}

export async function submitted(
  control: Control,
  projectId: string,
  content: string,
  requestId: string,
): Promise<number> {
  const result = await control.submitProjectMessage(projectId, content, requestId);

  if (!result.ok) throw new Error(`the message must be admitted: ${result.problem.code}`);

  return result.submissionId;
}

export async function untilAnswered(
  control: Control,
  projectId: string,
  count: number,
): Promise<readonly Entry[]> {
  const opened = await control.projectEvents(projectId);

  if (!opened.ok) throw new Error(`the events must open: ${opened.problem.code}`);
  const reader = opened.events.pipeThrough(new TextDecoderStream()).getReader();
  const events: AgentEvent[] = [];
  let buffer = "";

  try {
    while (answerCount(transcript(events)) < count) {
      const next = await reader.read();

      if (next.done) throw new Error("the event stream ended before the answers arrived");
      const split = (buffer + next.value).split("\n");
      buffer = split.pop() ?? "";
      const received = split.filter((line) => line !== "");
      events.push(...received.flatMap(readEvent));
    }
  } finally {
    await reader.cancel();
  }

  return transcript(events);
}

export async function answeredLines(
  control: Control,
  projectId: string,
  count: number,
): Promise<readonly Line[]> {
  return lines(await untilAnswered(control, projectId, count));
}

export async function hasRun(control: Control, projectId: string): Promise<boolean> {
  const opened = await control.projectEvents(projectId);

  if (!opened.ok) throw new Error(`the events must open: ${opened.problem.code}`);
  const reader = opened.events.pipeThrough(new TextDecoderStream()).getReader();
  let read = "";

  try {
    while (!read.includes("\n")) {
      const next = await reader.read();

      if (next.done) throw new Error("the event stream ended before its snapshot");
      read += next.value;
    }
  } finally {
    await reader.cancel();
  }

  return readEvent(read.split("\n")[0] ?? "").some(
    (event) => event.type === "snapshot" && event.run !== undefined,
  );
}
