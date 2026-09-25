import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import { NdjsonFrameReader } from "../../../src/facet/generation-0/execution-env-frame-reader.js";

type ExecFrame = Readonly<{
  readonly kind: "stdout" | "stderr";
  readonly data: string;
}>;

const text = gs.text({
  alphabet: `abc XYZ012'"\\\n\t\u0000é日🙂`,
  maxSize: 32,
});

const frame = gs.composite<ExecFrame>((tc) => ({
  kind: tc.draw(gs.sampledFrom(["stdout", "stderr"] as const)),
  data: `${tc.draw(text)}"\\\n\t\u0000é日🙂`,
}));

function splitBytes(bytes: Uint8Array, points: readonly number[]): Uint8Array[] {
  const sorted = [...new Set([0, ...points, bytes.length])].toSorted((a, b) => a - b);

  return sorted.slice(1).flatMap((end, index) => {
    const part = bytes.slice(sorted[index], end);

    return part.length > 0 ? [part] : [];
  });
}

function readableFromChunks(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;

  return new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();

        return;
      }

      controller.enqueue(chunks[index]);
      index += 1;
    },
  });
}

test("NdjsonFrameReader preserves generated exec frames under arbitrary byte partitioning", async () => {
  await hegel.testAsync(async (tc) => {
    const values = tc.draw(gs.arrays(frame, { minSize: 1, maxSize: 5 }));
    const serialized = values.map((value) => `${JSON.stringify(value)}\n`);
    const bytes = new TextEncoder().encode(serialized.join(""));

    const continuationOffsets = [...bytes].flatMap((byte, index) =>
      byte >= 0x80 && byte <= 0xbf && index > 0 ? [index] : [],
    );

    const forcedSplit = tc.draw(
      gs.integers({ minValue: 0, maxValue: continuationOffsets.length - 1 }),
    );

    const cuts = tc.draw(
      gs.arrays(gs.integers({ minValue: 1, maxValue: bytes.length - 1 }), { maxSize: 32 }),
    );

    const splitAt = continuationOffsets[forcedSplit] ?? 0;

    expect(bytes[splitAt]).toBeGreaterThanOrEqual(0x80);
    expect(bytes[splitAt]).toBeLessThanOrEqual(0xbf);

    const chunks = splitBytes(bytes, [1, splitAt, bytes.length - 1, ...cuts]);
    const reader = new NdjsonFrameReader(readableFromChunks(chunks).getReader());
    const seen: unknown[] = [];

    for (;;) {
      const result = await reader.next();

      if (result.kind !== "value") {
        expect(result.kind).toBe("eof");
        break;
      }

      seen.push(result.value);
    }

    expect(seen).toEqual(values);
    expect(await reader.next()).toEqual({ kind: "eof" });
  });
});
