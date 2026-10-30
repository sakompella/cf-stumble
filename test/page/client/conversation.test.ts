import * as Option from "effect/Option";
import { afterEach, expect, test } from "vitest";
import {
  applyEvent,
  EMPTY_CONVERSATION,
  type Conversation,
} from "../../../src/page/client/conversation.js";
import { eventLine } from "../../../src/page/client/events.js";
import { transcriptOf } from "../../../src/page/client/transcript.js";
import { context, openPiRun, type PiRun } from "./pi-run.js";

/**
 * A page that stayed connected and a page that connected just now must show the same
 * conversation: the first folded every event onto its snapshot, the second read one snapshot.
 */

let run: PiRun | undefined;

afterEach(async () => {
  await run?.close();
  run = undefined;
});

function folded(lines: readonly string[]): readonly Conversation[] {
  const states: Conversation[] = [];

  lines.reduce((conversation, line) => {
    const read = eventLine(line);

    if (read._tag === "Unreadable") {
      throw new Error(`the page could not read ${line}`);
    }

    const next = read._tag === "Event" ? applyEvent(conversation, read.event) : conversation;
    states.push(next);

    return next;
  }, EMPTY_CONVERSATION);

  return states;
}

async function settled(piRun: PiRun): Promise<Conversation> {
  const states = folded(await piRun.snapshotLine().then((line) => [line]));

  return states[0] ?? EMPTY_CONVERSATION;
}

function isAnswering(state: Conversation): boolean {
  return (
    Option.isSome(state.maybePartial) &&
    state.entries.some((entry) => entry.kind === "pi.tool-result")
  );
}

function texts(conversation: Conversation): readonly string[] {
  return transcriptOf(conversation, []).map((entry) =>
    entry._tag === "Text"
      ? `${entry.who}: ${entry.text}`
      : entry._tag === "Tool"
        ? entry.summary
        : entry.wording,
  );
}

test("folding every event of a run with a tool and a follow-up shows what a fresh snapshot shows", async () => {
  run = await openPiRun(["Done: two lines.", "Second answer."]);

  const first = await run.conversation.submit(
    { type: "input", content: "list files", requestId: "r1" },
    context,
  );

  const second = await run.conversation.submit(
    { type: "input", content: "follow up", requestId: "r2" },
    context,
  );

  await first.wait(context);
  await second.wait(context);
  await run.conversation.waitForIdle(context);

  const states = folded(run.lines);
  const live = states.at(-1) ?? EMPTY_CONVERSATION;
  const reconnected = await settled(run);

  expect(live).toEqual(reconnected);
  expect(texts(live)).toEqual([
    "you: list files",
    "assistant: Let me look.",
    "bash — done",
    "assistant: Done: two lines.",
    "you: follow up",
    "assistant: Second answer.",
  ]);
  expect(states.some((state) => state.inbox.length === 1)).toBe(true);
  expect(
    states.some((state) =>
      transcriptOf(state, []).some(
        (entry) =>
          entry._tag === "Tool" &&
          Option.exists(entry.maybeOutput, (output) => output.content === "line one\n"),
      ),
    ),
  ).toBe(true);
});

test("an answer streams into the transcript before its entry is committed", async () => {
  const answer = "A longer answer that the faux model streams over several commits.";
  run = await openPiRun([answer]);
  await (
    await run.conversation.submit({ type: "input", content: "go", requestId: "r1" }, context)
  ).wait(context);

  const partials = folded(run.lines).filter((state) => Option.isSome(state.maybePartial));
  const shownBeforeCommit = partials.map((state) => texts(state).at(-1) ?? "");

  expect(
    shownBeforeCommit.some(
      (text) => text.startsWith("assistant: A longer") && text !== `assistant: ${answer}`,
    ),
  ).toBe(true);
});

test("an aborted run reads as cancelled, live and after a reconnect", async () => {
  run = await openPiRun([
    "An answer long enough to be cut off while it streams, word after word after word.",
  ]);

  const submission = await run.conversation.submit(
    { type: "input", content: "go", requestId: "r1" },
    context,
  );

  const piRun = run;

  await expect.poll(() => folded(piRun.lines).some(isAnswering)).toBe(true);
  await run.conversation.abort(context);
  await submission.wait(context);

  const live = folded(run.lines).at(-1) ?? EMPTY_CONVERSATION;

  expect(live).toEqual(await settled(run));
  expect(live.isRunning).toBe(false);
  expect(texts(live).at(-1)).toBe("cancelled");
});
