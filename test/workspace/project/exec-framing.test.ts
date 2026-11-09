import { expect, test } from "vitest";
import { enqueueOutput, type FrameSequence } from "../../../src/workspace/project/exec-framing.js";

type OutputKind = "stdout" | "stderr";

interface Frame {
  kind: OutputKind;
  data: string;
}

function isFrame(value: unknown): value is Frame {
  if (typeof value !== "object" || value === null) return false;

  if (!("kind" in value) || !("data" in value)) return false;

  return typeof value.data === "string" && (value.kind === "stdout" || value.kind === "stderr");
}

async function framesOf(kind: OutputKind, chunks: readonly string[]): Promise<Frame[]> {
  const state: FrameSequence = { seq: 0 };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) enqueueOutput(state, controller, kind, chunk);

      controller.close();
    },
  });

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];

  for (;;) {
    const next = await reader.read();

    if (next.done) break;

    for (const line of decoder.decode(next.value).split("\n")) {
      if (line === "") continue;

      const parsed: unknown = JSON.parse(line);

      if (!isFrame(parsed)) throw new Error(`not a frame: ${line}`);

      frames.push(parsed);
    }
  }

  return frames;
}

function outputOf(frames: readonly Frame[]): string {
  return frames.map((frame) => frame.data).join("");
}

function endsWithUnpairedSurrogate(text: string): boolean {
  if (text === "") return false;

  const last = text.codePointAt(text.length - 1) ?? 0;

  return last >= 0xd800 && last <= 0xdbff;
}

test("a frame boundary never splits a surrogate pair", async () => {
  const data = "x".repeat(65_495) + "\u{1F600}" + "x".repeat(65_495);
  const frames = await framesOf("stdout", [data]);

  expect(outputOf(frames)).toBe(data);
  expect(frames.length).toBeGreaterThan(1);
  expect(frames.some((frame) => endsWithUnpairedSurrogate(frame.data))).toBe(false);
});

test("an emoji split across two chunks arrives whole", async () => {
  const emoji = "\u{1F600}";
  const first = "x".repeat(65_495) + emoji.slice(0, 1);
  const second = emoji.slice(1) + "y".repeat(30);
  const frames = await framesOf("stdout", [first, second]);

  expect(outputOf(frames)).toBe("x".repeat(65_495) + emoji + "y".repeat(30));
});
