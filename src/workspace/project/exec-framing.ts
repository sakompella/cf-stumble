import { MAX_EXEC_FRAME_BYTES, type ExecEvent } from "./protocol.js";

export interface FrameSequence {
  seq: number;
}

const encoder = new TextEncoder();

function encodeEvent(event: ExecEvent): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`);
}

export function enqueueEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  event: ExecEvent,
): void {
  const frame = encodeEvent(event);

  if (frame.byteLength > MAX_EXEC_FRAME_BYTES) {
    throw new Error("exec event exceeds the protocol frame limit");
  }

  controller.enqueue(frame);
}

function largestFrameEnd(
  kind: "stdout" | "stderr",
  data: string,
  start: number,
  seq: number,
): number {
  let low = start + 1;
  let high = data.length;
  let end = start;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);

    const frame = encodeEvent({ kind, seq, data: data.slice(start, middle) });

    if (frame.byteLength <= MAX_EXEC_FRAME_BYTES) {
      end = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  while (end > start && end < data.length && isHighSurrogate(data.charCodeAt(end - 1))) end -= 1;

  if (end === start) throw new Error("exec frame limit cannot encode one character");

  return end;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function enqueueOutput(
  state: FrameSequence,
  controller: ReadableStreamDefaultController<Uint8Array>,
  kind: "stdout" | "stderr",
  data: string,
): void {
  if (data === "") {
    enqueueEvent(controller, { kind, seq: state.seq++, data });

    return;
  }

  for (let start = 0; start < data.length;) {
    const end = largestFrameEnd(kind, data, start, state.seq);
    enqueueEvent(controller, { kind, seq: state.seq++, data: data.slice(start, end) });
    start = end;
  }
}
