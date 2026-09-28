import type { ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import type { ProjectTurnFrame } from "../../src/supervisor/projects/turn-frames.js";
import type { HarnessScenario } from "./fixtures.mjs";
import { isJsonRecord, isJsonString, type JsonValue } from "./json.mjs";
import { sendJson } from "./server-routes.mjs";
import { freshStreamWatch, threadOf, waitUntil, type ScenarioState } from "./server-state.mjs";
import { turnScript } from "./turn-fixture.mjs";
import { turnMessages } from "./turn-messages.mjs";

/**
 * The streaming turn, and the two refusals that arrive instead of one.
 *
 * Each frame is written and then awaited separately, so the response really is incremental: a page
 * that only paints when the body ends fails the streaming assertion instead of passing it by
 * accident. A browser that goes away mid-stream ends the loop, and the thread does not advance —
 * which is what makes the late-frame check meaningful, because an abandoned turn saves nothing.
 *
 * A held script stops after its named frame count, records that the barrier was reached, and waits
 * for the case to release the rest. Whatever the page shows at that moment, it showed while the
 * response body was still open.
 *
 * A terminal frame that says the thread was saved is where the stub saves it: the prompt and every
 * frame streamed before it become the thread's next revision. The recorded frame's own revision
 * and message count are replaced with what was stored, so the page's claim and a later thread
 * read cannot disagree, and a second turn saves at the next revision rather than repeating one.
 */

/** How long each frame waits behind the previous one. Slow enough to observe partial rendering. */
export const FRAME_INTERVAL_MS = 120;

/** A recorded request whose answer status the turn route fills in once it knows it. */
export type AnsweredRequest = { status: number };

/** The turn request the page sent: the project in its path and the prompt in its body. */
type TurnRequest = Readonly<{ projectId: string; prompt: string }>;

/** Store the streamed turn when `terminal` says it was saved, and restate `terminal` to match. */
function settle(
  state: ScenarioState,
  turn: TurnRequest,
  streamed: readonly ProjectTurnFrame[],
  terminal: ProjectTurnFrame,
): ProjectTurnFrame {
  const saves = terminal.kind === "saved" || (terminal.kind === "turn-failed" && terminal.saved);

  if (!saves) {
    return terminal;
  }

  const before = threadOf(state, turn.projectId);
  const revision = before.revision + 1;
  const messages = [...before.messages, ...turnMessages(turn.prompt, streamed)];
  state.threads.set(turn.projectId, { revision, messages });

  return terminal.kind === "saved"
    ? { kind: "saved", revision, messageCount: messages.length }
    : { ...terminal, revision };
}

async function streamFrames(
  res: ServerResponse,
  state: ScenarioState,
  turn: TurnRequest,
): Promise<void> {
  const script = turnScript(state.scenario);
  const watch = freshStreamWatch();
  state.stream = watch;
  res.on("close", () => {
    watch.responseClosed = true;
  });
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });

  const streamed: ProjectTurnFrame[] = [];

  for (const [index, frame] of script.frames.entries()) {
    if (script.hold > 0 && index === script.hold) {
      watch.barrierReached = true;
      await waitUntil(
        () => watch.released || res.destroyed,
        30_000,
        "a case to release the held turn frames",
      );
    }

    await sleep(FRAME_INTERVAL_MS);

    if (res.writableEnded || res.destroyed) {
      return;
    }

    res.write(`${JSON.stringify(settle(state, turn, streamed, frame))}\n`);
    watch.framesWritten = index + 1;
    streamed.push(frame);
  }

  res.end();
}

function turnRefusal(
  scenario: HarnessScenario,
): Readonly<{ status: number; code: string }> | undefined {
  if (scenario === "turn-conflict") {
    return { status: 409, code: "turn-conflict" };
  }

  if (scenario === "no-active-generation") {
    return { status: 503, code: "no-active-generation" };
  }

  return undefined;
}

function promptOf(body: JsonValue): string | undefined {
  const prompt = isJsonRecord(body) ? body.prompt : undefined;

  return prompt !== undefined && isJsonString(prompt) && prompt.trim() !== "" ? prompt : undefined;
}

export async function serveTurn(
  res: ServerResponse,
  state: ScenarioState,
  request: Readonly<{ projectId: string; body: JsonValue }>,
  record: AnsweredRequest,
): Promise<void> {
  const prompt = promptOf(request.body);

  if (prompt === undefined) {
    record.status = 400;
    sendJson(res, 400, { ok: false, error: { code: "invalid-turn-request" } });

    return;
  }

  const refusal = turnRefusal(state.scenario);

  if (refusal === undefined) {
    record.status = 200;
    await streamFrames(res, state, { projectId: request.projectId, prompt });

    return;
  }

  record.status = refusal.status;
  sendJson(res, refusal.status, { ok: false, problem: { code: refusal.code } });
}
