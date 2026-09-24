import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import { parseProjectId } from "../../../src/project-catalog.js";
import { TurnBound } from "../../../src/supervisor/projects/turn-bound.js";
import { projectTurnStream } from "../../../src/supervisor/projects/turn-stream.js";
import type { ProjectThreadResult } from "../../../src/supervisor/threads/index.js";

const projectId = parseProjectId("project-one");

if (projectId === undefined) throw new Error("expected a valid project id");

const text = gs.text({ alphabet: "abc XYZ012-", maxSize: 80 });

function splitBytes(bytes: Uint8Array, points: readonly number[]): Uint8Array[] {
  const sorted = [...new Set([0, ...points, bytes.length])].toSorted((a, b) => a - b);

  return sorted.slice(1).flatMap((end, index) => {
    const part = bytes.slice(sorted[index], end);

    return part.length > 0 ? [part] : [];
  });
}

test("reassembles a turn identically when its NDJSON is split at arbitrary byte offsets", async () => {
  await hegel.testAsync(async (tc) => {
    const forwardedText = tc.draw(text);
    const raw = `${JSON.stringify({ kind: "text", text: forwardedText })}\n${JSON.stringify({ kind: "rejected", code: "invalid-turn-request" })}\n`;
    const bytes = new TextEncoder().encode(raw);

    const points = tc.draw(
      gs.arrays(gs.integers({ minValue: 0, maxValue: bytes.length }), { maxSize: 8 }),
    );

    const requests: unknown[] = [];

    const stream = projectTurnStream({
      projectId,
      leaseId: "lease-property",
      threads: {
        finishTurn: (): ProjectThreadResult => ({
          ok: false,
          problem: { code: "turn-not-active", projectId },
        }),
        abandonTurn: (...request: unknown[]): ProjectThreadResult => {
          requests.push(request);

          return { ok: false, problem: { code: "turn-not-active", projectId } };
        },
      },
      now: () => 0,
      bound: new TurnBound(10_000, () => 0),
      frames: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of splitBytes(bytes, points)) controller.enqueue(chunk);
          controller.close();
        },
      }),
    });

    const reader = stream.getReader();
    const first = await reader.read();
    const second = await reader.read();
    const end = await reader.read();

    expect(first.done).toBe(false);
    expect(JSON.parse(new TextDecoder().decode(first.value))).toEqual({
      kind: "text",
      text: forwardedText,
    });
    expect(second.done).toBe(false);
    expect(JSON.parse(new TextDecoder().decode(second.value))).toEqual({
      kind: "turn-rejected",
      code: "invalid-turn-request",
    });
    expect(end.done).toBe(true);
    expect(requests).toHaveLength(1);
  });
});
