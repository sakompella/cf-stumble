import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { beforeEach, expect, test, vi } from "vitest";

import { parseProjectId } from "../../../src/project-catalog.js";
import type { ProjectId } from "../../../src/project-catalog.js";
import { TurnBound } from "../../../src/supervisor/projects/turn-bound.js";
import { projectTurnStream } from "../../../src/supervisor/projects/turn-stream.js";
import { turnTrace } from "../../../src/supervisor/projects/turn-log.js";
import { PROJECT_TURN_FRAME_MAX_BYTES } from "../../../src/supervisor/projects/turn-frames.js";
import type { ProjectThreadResult } from "../../../src/supervisor/threads/index.js";

function testProjectId(): ProjectId {
  const projectId = parseProjectId("project-one");

  if (projectId === undefined) throw new Error("expected a valid project id");

  return projectId;
}

const projectId = testProjectId();

// Every generated turn settles and logs; the events are not what these properties check.
beforeEach(() => {
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
});

const text = gs.text({ alphabet: "abc XYZ012-é日🙂", maxSize: 80 });

function splitBytes(bytes: Uint8Array, points: readonly number[]): Uint8Array[] {
  const sorted = [...new Set([0, ...points, bytes.length])].toSorted((a, b) => a - b);

  return sorted.slice(1).flatMap((end, index) => {
    const part = bytes.slice(sorted[index], end);

    return part.length > 0 ? [part] : [];
  });
}

async function readTurn(chunks: readonly Uint8Array[]): Promise<readonly unknown[]> {
  const releases: unknown[] = [];

  const stream = projectTurnStream({
    projectId,
    leaseId: "lease-property",
    threads: {
      finishTurn: (): ProjectThreadResult => ({
        ok: false,
        problem: { code: "turn-not-active", projectId },
      }),
      abandonTurn: (...request: unknown[]): ProjectThreadResult => {
        releases.push(request);

        return { ok: false, problem: { code: "turn-not-active", projectId } };
      },
    },
    now: () => 0,
    bound: new TurnBound(10_000, () => 0),
    trace: turnTrace(projectId, "lease-property", undefined, 0),
    frames: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  });

  const reader = stream.getReader();
  const output: unknown[] = [];

  for (;;) {
    const result = await reader.read();

    if (result.done) break;

    output.push(JSON.parse(new TextDecoder().decode(result.value)));
  }

  expect(releases).toHaveLength(1);

  return output;
}

test("reassembles several Unicode turn frames at arbitrary byte offsets", async () => {
  await hegel.testAsync(async (tc) => {
    const forwardedTexts = tc
      .draw(gs.arrays(text, { minSize: 1, maxSize: 5 }))
      .map((value) => `${value}é日🙂`);

    const lines = forwardedTexts.map((value) => JSON.stringify({ kind: "text", text: value }));

    const terminal = JSON.stringify({ kind: "rejected", code: "invalid-turn-request" });
    const raw = `${[...lines, terminal].join("\n")}\n`;
    const bytes = new TextEncoder().encode(raw);

    const continuationOffsets = [...bytes].flatMap((byte, index) =>
      byte >= 0x80 && byte <= 0xbf ? [index] : [],
    );

    const forcedUnicodeSplit =
      continuationOffsets[
        tc.draw(gs.integers({ minValue: 0, maxValue: continuationOffsets.length - 1 }))
      ] ?? 0;

    const points = tc.draw(
      gs.arrays(gs.integers({ minValue: 0, maxValue: bytes.length }), { maxSize: 8 }),
    );

    const output = await readTurn(splitBytes(bytes, [...points, forcedUnicodeSplit]));

    expect(output).toEqual([
      ...forwardedTexts.map((value) => ({ kind: "text", text: value })),
      { kind: "turn-rejected", code: "invalid-turn-request" },
    ]);
  });
});

test("rejects an oversized frame regardless of where its bytes are split", async () => {
  await hegel.testAsync(
    async (tc) => {
      const raw = `${JSON.stringify({ kind: "text", text: "x".repeat(PROJECT_TURN_FRAME_MAX_BYTES) })}\n`;
      const bytes = new TextEncoder().encode(raw);

      const points = tc.draw(
        gs.arrays(gs.integers({ minValue: 0, maxValue: bytes.length }), { maxSize: 8 }),
      );

      const [output] = await readTurn(splitBytes(bytes, points));

      expect(output).toEqual({ kind: "stream-invalid", code: "oversized-frame" });
    },
    { testCases: 20 },
  );
});
