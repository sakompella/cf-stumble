import { env, RpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { vi } from "vitest";
import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import { ChatGPTCredentialStore } from "../../../src/chatgpt/index.js";
import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import { builtGeneration } from "../../facet/generation-1/built-module-map.js";
import {
  FakeExecBackend,
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
} from "../../workspace/project/fakes.js";
import { FakeTenantWorkspace } from "../projects/fake-tenant-workspace.js";
import {
  activateGeneration,
  connectedSupervisor,
  prepareWithModuleMap,
  submitCandidate,
} from "../helpers.js";

const RESPONSES_URL = "https://api.openai.com/v1/responses";

class UnkillableProjectTarget extends ProjectRpcTarget {
  override kill(): ReturnType<ProjectRpcTarget["kill"]> {
    return Promise.resolve({ ok: true, value: null });
  }
}

export class ProjectWorkspace extends FakeTenantWorkspace {
  readonly files = new FakeProjectFilesystemProvider();
  readonly execs = new FakeExecBackend();
  killsCommands = true;

  project() {
    const Target = this.killsCommands ? ProjectRpcTarget : UnkillableProjectTarget;

    return Promise.resolve(
      new RpcStub(new Target(this.files, new FakeProjectTransactions(), this.execs)),
    );
  }

  seedFile(path: string, text: string): void {
    const parts = path.split("/").filter((part) => part !== "");

    for (let depth = 1; depth < parts.length; depth += 1) {
      const directory = `/${parts.slice(0, depth).join("/")}`;

      if (!this.files.nodes.has(directory))
        this.files.nodes.set(directory, { type: "dir", mtimeMs: 0 });
    }

    this.files.nodes.set(path, { type: "file", data: new TextEncoder().encode(text), mtimeMs: 0 });
  }
}

type ResponsesInput = readonly object[];

type Control = Awaited<ReturnType<typeof connectedSupervisor>>;

type Answer = () => Promise<Response>;

function sse(events: readonly object[]): Response {
  const body = [...events, { type: "response.completed", response: {} }]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");

  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

export const says =
  (text: string): Answer =>
  () =>
    Promise.resolve(sse([{ type: "response.output_text.delta", output_index: 0, delta: text }]));

export const calls =
  (name: string, args: Readonly<Record<string, string>>): Answer =>
  () =>
    Promise.resolve(
      sse([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "function_call", call_id: "call_1", name, arguments: JSON.stringify(args) },
        },
      ]),
    );

export function held() {
  let released: Answer | undefined;

  const respond: Answer = async () => {
    const answer = await vi.waitUntil(() => released, { timeout: 15_000, interval: 10 });

    return answer();
  };

  return {
    respond,
    release: (answer: Answer) => {
      released = answer;
    },
  };
}

export function scriptModel(...answers: readonly Answer[]) {
  const inputs: ResponsesInput[] = [];
  const queue = [...answers];

  vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
    if (new Request(url).url !== RESPONSES_URL)
      return Promise.resolve(new Response("{}", { status: 404 }));
    // SAFETY: the ChatGPT model turn sends a JSON Responses request body.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/no-base-to-string
    const body = JSON.parse(String(init?.body)) as { input: ResponsesInput };
    inputs.push(body.input);
    const answer = queue.shift();

    if (answer === undefined)
      return Promise.reject(new Error("the scripted model has no answer left"));

    return answer();
  });

  return { inputs };
}

async function commitNamed(name: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(name));

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function servingGeneration1(
  name: string,
  workspace: ProjectWorkspace,
): Promise<Control> {
  // SAFETY: the fake implements every Workspace Host RPC the Supervisor sends during a run.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion
  const host = workspace as unknown as ReturnType<typeof env.WORKSPACE_HOST.getByName>;
  vi.spyOn(env.WORKSPACE_HOST, "getByName").mockReturnValue(host);

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

export function transcript(events: readonly AgentEvent[]): readonly EntryRecord[] {
  const entries = new Map<number, EntryRecord>();

  for (const event of events) {
    const ended =
      event.type === "snapshot"
        ? event.entries
        : (event.type === "message_end" ||
              event.type === "tool_execution_end" ||
              event.type === "entry_appended") &&
            event.entry !== undefined
          ? [event.entry]
          : [];

    for (const entry of ended) entries.set(entry.id, entry);
  }

  return [...entries.values()].toSorted((a, b) => a.id - b.id);
}

export type Line = Readonly<{ role: string; text: string }>;

export function lines(entries: readonly EntryRecord[]): readonly Line[] {
  return entries.flatMap((entry) =>
    (entry.model ?? [])
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role,
        text: Array.isArray(message.content)
          ? message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
          : message.content,
      })),
  );
}

export function answerCount(entries: readonly EntryRecord[]): number {
  return entries.filter((entry) =>
    (entry.model ?? []).some(
      (message) => message.role === "assistant" && message.stopReason === "stop",
    ),
  ).length;
}

export async function untilAnswered(
  control: Control,
  projectId: string,
  count: number,
): Promise<readonly EntryRecord[]> {
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
      // SAFETY: the facet writes one Pi Durable agent event per line.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      events.push(...received.map((line) => JSON.parse(line) as AgentEvent));
    }
  } finally {
    await reader.cancel();
  }

  return transcript(events);
}
