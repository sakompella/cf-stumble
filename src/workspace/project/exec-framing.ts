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
  let result = start;

  while (low <= high) {
    let middle = Math.floor((low + high) / 2);

    if (middle > start && isHighSurrogate(data.codePointAt(middle - 1) ?? 0)) middle -= 1;

    if (middle <= start) {
      low = start + 1;
      continue;
    }

    const frame = encodeEvent({ kind, seq, data: data.slice(start, middle) });

    if (frame.byteLength <= MAX_EXEC_FRAME_BYTES) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (result === start) throw new Error("exec frame limit cannot encode one character");

  return result;
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
