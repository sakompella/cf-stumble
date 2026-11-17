import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import { afterEach, expect, test } from "vitest";
import type { Conversation } from "../../../src/page/client/conversation.js";
import { phaseWording, type RunPhase } from "../../../src/page/client/run-phase.js";
import { readFirstView } from "../../../src/page/client/view-reader.js";
import { eventuallyTruthy } from "../../eventually.js";
import { folded } from "./folded.js";
import { context, openPiRun, type PiRun } from "./pi-run.js";

let run: PiRun | undefined;

afterEach(async () => {
  await run?.close();
  run = undefined;
});

function phases(lines: readonly string[]): readonly string[] {
  return folded(lines)
    .map((state) => state.run)
    .filter((tag, index, all) => tag !== all[index - 1]);
}

test("a run waits as Preparing until its environment is ready, then the model is asked and answers", async () => {
  const open = { release: (): void => {} };

  const environment = new Promise<void>((resolve) => {
    open.release = resolve;
  });

  run = await openPiRun(["Done: two lines."], environment);
  const piRun = run;

  const submission = await run.conversation.submit(
    { type: "input", content: "list files", requestId: "r1" },
    context,
  );

  await eventuallyTruthy(() => phases(piRun.lines).includes("Preparing"));
  expect(phases(piRun.lines)).toEqual(["Idle", "Preparing"]);

  open.release();
  await submission.wait(context);
  await run.conversation.waitForIdle(context);

  expect(phases(run.lines).slice(0, 4)).toEqual([
    "Idle",
    "Preparing",
    "WaitingForModel",
    "Working",
  ]);
  expect(phases(run.lines).at(-1)).toBe("Idle");
});

function viewWith(live: Schema.Json): string {
  return JSON.stringify([
    ["r", { conversation: { id: 1 }, entries: [], items: [], docs: { "pi.live": live } }],
  ]);
}

const RUN = { taskId: 1, inputs: [1], turns: 0 };

const SLOT = { callId: "call-1", name: "bash", status: "running" };

const LIVE_DOCS: readonly (readonly [string, Schema.Json, RunPhase, string])[] = [
  ["no run", {}, "Idle", ""],
  ["a run before any generation", { run: RUN }, "Preparing", "preparing the workspace"],
  [
    "a generation without text yet",
    { run: RUN, generation: { attempt: 1 } },
    "WaitingForModel",
    "waiting for the model",
  ],
  [
    "a generation streaming text",
    {
      run: RUN,
      generation: {
        attempt: 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hi" }],
          stopReason: "pending",
        },
      },
    },
    "Working",
    "",
  ],
  ["a tool round", { run: RUN, tools: [SLOT] }, "Working", ""],
  [
    "a compaction",
    { run: RUN, compactions: [{ taskId: 3, trigger: "background" }] },
    "Compacting",
    "summarizing earlier messages",
  ],
  [
    "an answered run that waits for its after-run tasks",
    { run: { ...RUN, afterRun: {} } },
    "Working",
    "",
  ],
];

test.each(LIVE_DOCS)("%s reads as its phase", (_name, live, tag, wording) => {
  const conversation: Option.Option<Conversation> = readFirstView(viewWith(live));

  expect(Option.map(conversation, (state) => state.run)).toEqual(Option.some(tag));
  expect(Option.map(conversation, (state) => phaseWording(state.run))).toEqual(
    Option.some(wording),
  );
});
