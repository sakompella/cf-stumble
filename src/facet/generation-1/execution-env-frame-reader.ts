import {
  isExecEvent,
  MAX_EXEC_FRAME_BYTES,
  type ExecEvent,
} from "../../workspace/project/protocol.js";
import { LineReader } from "./line-reader.js";

type FrameOutcome =
  | { readonly kind: "value"; readonly value: ExecEvent }
  | { readonly kind: "malformed" }
  | { readonly kind: "eof" }
  | { readonly kind: "stream-error" };

export class NdjsonFrameReader {
  readonly #lines: LineReader;

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.#lines = new LineReader(reader, MAX_EXEC_FRAME_BYTES);
  }

  cancel(): void {
    this.#lines.cancel();
  }

  async next(): Promise<FrameOutcome> {
    const line = await this.#lines.next();

    if (line.kind === "line") {
      try {
        const value: unknown = JSON.parse(line.text);

        return isExecEvent(value) ? { kind: "value", value } : { kind: "malformed" };
      } catch {
        return { kind: "malformed" };
      }
    }

    if (line.kind === "eof") return { kind: "eof" };

    if (line.kind === "stream-error") return { kind: "stream-error" };

    return { kind: "malformed" };
  }
}
