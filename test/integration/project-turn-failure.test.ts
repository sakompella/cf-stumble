/// <reference types="@cloudflare/vitest-plugin/types" />

import { evictDurableObject, reset } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import type { AgentMessage } from "@cf-stumble/pi";
import type { ProjectTurnFrame } from "../../src/supervisor/projects/turn-frames.js";
import { parseThreadMessages, type SerializedThread } from "../../src/supervisor/threads/index.js";
import { sampleProjectOne } from "../project-fixtures.js";
import { FakeTenantWorkspace } from "../supervisor/projects/fake-tenant-workspace.js";
import {
  activateGeneration,
  artifact,
  connectSampleProjects,
  submitCandidate,
} from "../supervisor/helpers.js";
import { THREAD_MESSAGE_SAMPLES } from "../supervisor/threads/message-samples.js";
import { ownerSession, stubExternalBoundaries } from "./owner-session.js";

/**
 * A project turn through `POST /api/projects/{id}/turn`, with the Worker, the Supervisor Durable
 * Object, its thread store, the Workspace Host's provisioning surface, and a loaded generation
 * facet all real. Computer's shell and GitHub's REST API are the only fakes, and the generation is
 * a small scripted module map rather than Pi, so the model is never called.
 *
 * `turn-settle.ts` decides that a failed turn keeps its conversation. The scripted turn tests
 * (`turn-faults.test.ts`) replace the Supervisor's start path, and the owner page fixture reports
 * `saved: true` without storing anything, so neither shows that the conversation a failed turn
 * saved is the one the next request reads and the next turn continues from.
 */

const HARNESS_COMMIT = "c0ffee0000000000000000000000000000000001";

const promptText = (text: string) => [{ type: "text", text }] as const;

const user = (text: string): AgentMessage => ({
  ...THREAD_MESSAGE_SAMPLES.user,
  content: [...promptText(text)],
});

const assistant = (text: string, stopReason: "stop" | "error"): AgentMessage => ({
  ...THREAD_MESSAGE_SAMPLES.assistant,
  content: [...promptText(text)],
  stopReason,
});

/**
 * The generation's reply to each prompt: the frames it writes, built from the history the
 * Supervisor handed it. `corrupt` ends with a message no thread may store.
 */
const generationSource = `
import { DurableObject } from "cloudflare:workers";

const user = ${JSON.stringify(user("PROMPT"))};
const assistant = ${JSON.stringify(assistant("REPLY", "stop"))};
const said = (template, text, extra = {}) => ({ ...template, ...extra, content: [{ type: "text", text }] });

const replies = {
  fail: (history, prompt) => [
    { kind: "text", text: "half an answer" },
    {
      kind: "failed",
      code: "model-error",
      state: { messages: [...history, said(user, prompt), said(assistant, "half an answer", { stopReason: "error" })] },
    },
  ],
  continue: (history, prompt) => [
    { kind: "completed", state: { messages: [...history, said(user, prompt), said(assistant, "finished it")] } },
  ],
  corrupt: (history) => [
    { kind: "completed", state: { messages: [...history, { role: "not-a-message" }] } },
  ],
};

export class MainFacet extends DurableObject {
  fetch() {
    return new Response("ready");
  }

  startTurn(_capability, request) {
    const encoder = new TextEncoder();
    const frames = replies[request.prompt](request.messages, request.prompt);

    return new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(JSON.stringify(frame) + "\\n"));
        controller.close();
      },
    });
  }
}
`;

/** The fake Workspace Host, plus the project capability a turn obtains before it starts. */
class TurnWorkspace extends FakeTenantWorkspace {
  /** The scripted generation never calls the capability, so an empty one is enough. */
  project(): Promise<object> {
    return Promise.resolve({});
  }
}

type Owner = Awaited<ReturnType<typeof ownerSession>>;

const projectPath = `/api/projects/${sampleProjectOne.id}`;

/** The frames the browser receives for one turn, in order. */
async function turn(owner: Owner, prompt: string): Promise<readonly ProjectTurnFrame[]> {
  const response = await owner.post(`${projectPath}/turn`, { prompt });

  expect(response.status).toBe(200);
  const text = await new Response(response.body).text();

  // SAFETY: the Supervisor writes one proven ProjectTurnFrame per line; `toEqual` checks each one.
  return (
    text
      .split("\n")
      .filter((line) => line !== "")
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      .map((line) => JSON.parse(line) as ProjectTurnFrame)
  );
}

/** The thread as a fresh request reads it, with its conversation read by the thread's parser. */
async function savedThread(owner: Owner) {
  const response = await owner.get(`${projectPath}/thread`);

  expect(response.status).toBe(200);
  // SAFETY: a 200 from the thread route carries `{ ok: true, thread }` (`routes/owner-api.ts`).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const { thread } = (await response.json()) as { thread: SerializedThread };
  const conversation = parseThreadMessages(thread.conversation);

  if (conversation.isErr()) throw new Error(`the saved conversation must parse`);

  return { ...thread, conversation: conversation.value };
}

async function servingScriptedGeneration(owner: Owner): Promise<void> {
  const label = await submitCandidate(owner.supervisor, HARNESS_COMMIT);

  const checked = await owner.supervisor.checkGenerationStartup(
    label,
    artifact(HARNESS_COMMIT, generationSource),
  );

  if (!checked.ok || checked.report.stage !== "ready") {
    throw new Error("the scripted generation must pass its startup check");
  }

  await activateGeneration(owner.supervisor, label);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

test("a failed turn's saved conversation is what the next request reads and the next turn continues", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  stubExternalBoundaries(new TurnWorkspace());
  const owner = await ownerSession("integration-failed-turn");
  await servingScriptedGeneration(owner);

  // The catalog row a connection writes. Connecting over HTTP is covered by
  // `project-disconnect.test.ts`; here the turn still provisions the clone through the fake.
  await connectSampleProjects(owner.supervisor);

  await expect(turn(owner, "fail")).resolves.toEqual([
    { kind: "text", text: "half an answer" },
    { kind: "turn-failed", code: "model-error", saved: true, revision: 1 },
  ]);

  const failedTurn = [user("fail"), assistant("half an answer", "error")];

  // The saved thread lives in the Supervisor's storage, not in the instance that ran the turn.
  await evictDurableObject(owner.supervisor);

  await expect(savedThread(owner)).resolves.toEqual(
    expect.objectContaining({ conversation: failedTurn, revision: 1, turnActive: false }),
  );

  await expect(turn(owner, "continue")).resolves.toEqual([
    { kind: "saved", revision: 2, messageCount: 4 },
  ]);

  const continued = [...failedTurn, user("continue"), assistant("finished it", "stop")];

  await expect(savedThread(owner)).resolves.toEqual(
    expect.objectContaining({ conversation: continued, revision: 2, turnActive: false }),
  );

  const refusedSave = await turn(owner, "corrupt");

  expect(refusedSave).toEqual([{ kind: "save-failed", code: "invalid-messages" }]);
  await expect(savedThread(owner)).resolves.toEqual(
    expect.objectContaining({ conversation: continued, revision: 2, turnActive: false }),
  );
});
