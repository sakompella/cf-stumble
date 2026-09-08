import type { ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import type { HarnessScenario } from "./fixtures.mjs";
import { sendJson } from "./server-routes.mjs";
import { freshStreamWatch, waitUntil, type ScenarioState } from "./server-state.mjs";
import { turnScript } from "./turn-fixture.mjs";

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
 */

/** How long each frame waits behind the previous one. Slow enough to observe partial rendering. */
export const FRAME_INTERVAL_MS = 120;

/** A recorded request whose answer status the turn route fills in once it knows it. */
export type AnsweredRequest = { status: number };

async function streamFrames(
  res: ServerResponse,
  state: ScenarioState,
  projectId: string,
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
    res.write(`${JSON.stringify(frame)}\n`);
    watch.framesWritten = index + 1;
    if (frame.kind === "saved") {
      state.threads.set(projectId, { revision: frame.revision, messageCount: frame.messageCount });
    }
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

export async function serveTurn(
  res: ServerResponse,
  state: ScenarioState,
  projectId: string,
  record: AnsweredRequest,
): Promise<void> {
  const refusal = turnRefusal(state.scenario);
  if (refusal === undefined) {
    record.status = 200;
    await streamFrames(res, state, projectId);
    return;
  }
  record.status = refusal.status;
  sendJson(res, refusal.status, { ok: false, problem: { code: refusal.code } });
}
