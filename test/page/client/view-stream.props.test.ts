import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { JsonValue } from "@earendil-works/chord";
import { diffRevisions } from "@earendil-works/chord/delta";
import * as Option from "effect/Option";
import { expect, test } from "vitest";
import { heldTranscript, viewReader } from "../../../src/page/client/view-reader.js";
import { transcriptOf } from "../../../src/page/client/transcript.js";

type Revision = JsonValue;

function reader() {
  return viewReader(heldTranscript(() => Promise.reject(new Error("no history"))));
}

function userEntry(id: number) {
  return {
    id,
    conversationId: 1,
    kind: "pi.user",
    model: [{ role: "user", content: `message ${id}` }],
  };
}

function entryIds(line: string, read: ReturnType<typeof reader>): readonly number[] {
  return Option.match(read(line), {
    onNone: () => [],
    onSome: ({ items }) => items.flatMap((item) => (item.kind === "entry" ? [item.entry.id] : [])),
  });
}

test("merging windows that slide, jump and restart keeps every entry once and in order", () => {
  hegel.test(
    (tc) => {
      const ids = Array.from({ length: 40 }, (_, index) => index * 2 + 1);
      const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 12 }));
      const read = reader();
      const seen = new Set<number>();
      let newest = 0;

      for (let step = 0; step < steps; step += 1) {
        newest = tc.draw(gs.integers({ minValue: newest, maxValue: ids.length }));
        const start = tc.draw(gs.integers({ minValue: 0, maxValue: newest }));
        const window = ids.slice(start, newest);
        const entries = window.map(userEntry);

        const view: Revision =
          start === 0
            ? { conversation: { id: 1 }, entries, docs: {} }
            : { conversation: { id: 1 }, entries, before: ids[start - 1] ?? 0, docs: {} };

        for (const id of window) seen.add(id);

        const shown = entryIds(JSON.stringify([["r", view]]), read);

        expect(shown).toEqual([...shown].toSorted((a, b) => a - b));
        expect(new Set(shown).size).toBe(shown.length);
        expect(new Set(shown)).toEqual(seen);
      }
    },
    { testCases: 200 },
  );
});

function revision(entries: number, partial: number, queued: number): Revision {
  const live =
    partial === 0
      ? {}
      : {
          "pi.live": {
            run: { inputs: [1] },
            generation: {
              attempt: 1,
              message: {
                role: "assistant",
                content: [{ type: "text", text: "word ".repeat(partial) }],
                stopReason: "pending",
              },
            },
            tools: [{ callId: "t", name: "bash", status: "running", output: "o".repeat(partial) }],
          },
        };

  const inbox = queued === 0 ? {} : { "pi.inbox": { items: [{ id: 9, content: "later" }] } };

  return {
    conversation: { id: 1 },
    entries: Array.from({ length: entries }, (_, index) => userEntry(index + 1)),
    docs: { ...live, ...inbox },
  };
}

test("a page that joins mid-run shows what a page that watched from the start shows", () => {
  hegel.test(
    (tc) => {
      const count = tc.draw(gs.integers({ minValue: 1, maxValue: 10 }));
      let entries = 0;

      const revisions = Array.from({ length: count }, () => {
        entries += tc.draw(gs.integers({ minValue: 0, maxValue: 2 }));

        return revision(
          entries,
          tc.draw(gs.integers({ minValue: 0, maxValue: 6 })),
          tc.draw(gs.integers({ minValue: 0, maxValue: 1 })),
        );
      });

      const joinAt = tc.draw(gs.integers({ minValue: 0, maxValue: count - 1 }));
      const early = reader();
      const late = reader();
      const empty = revision(0, 0, 0);

      revisions.forEach((current, index) => {
        const previous = revisions[index - 1] ?? empty;
        const ops = JSON.stringify(diffRevisions(previous, current));

        const first = index === 0 ? JSON.stringify([["r", current]]) : ops;
        const fromStart = early(first);

        if (index < joinAt) return;

        const joined = late(index === joinAt ? JSON.stringify([["r", current]]) : ops);

        expect(Option.isSome(joined)).toBe(true);
        expect(joined).toEqual(fromStart);
        expect(
          Option.map(joined, (conversation) => transcriptOf(conversation, [], "repo").length),
        ).toEqual(
          Option.map(fromStart, (conversation) => transcriptOf(conversation, [], "repo").length),
        );
      });
    },
    { testCases: 200 },
  );
});
