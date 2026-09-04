import { MAX_EXEC_FRAME_BYTES } from "../../workspace/project/protocol.js";

export type FrameOutcome =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "malformed" }
  | { readonly kind: "eof" }
  | { readonly kind: "stream-error" };

function newlineIndex(bytes: Uint8Array, start: number): number {
  for (let index = start; index < bytes.byteLength; index++) {
    if (bytes[index] === 10) return index;
  }
  return -1;
}

function join(parts: readonly Uint8Array[], length: number): Uint8Array {
  const frame = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    frame.set(part, offset);
    offset += part.byteLength;
  }
  return frame;
}

export class NdjsonFrameReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #chunk: Uint8Array | undefined;
  #offset = 0;
  #parts: Uint8Array[] = [];
  #frameBytes = 0;
  #ended = false;

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.#reader = reader;
  }

  cancel(): void {
    void this.#reader.cancel().catch(() => {});
  }

  async next(): Promise<FrameOutcome> {
    for (;;) {
      const chunk = this.#chunk;
      if (chunk !== undefined) {
        const newline = newlineIndex(chunk, this.#offset);
        const end = newline === -1 ? chunk.byteLength : newline;
        if (!this.#append(chunk.subarray(this.#offset, end), newline !== -1)) {
          return { kind: "malformed" };
        }
        this.#offset = newline === -1 ? chunk.byteLength : newline + 1;
        if (this.#offset === chunk.byteLength) {
          this.#chunk = undefined;
          this.#offset = 0;
        }
        if (newline !== -1) return this.#parseFrame();
        continue;
      }
      if (this.#ended) return this.#frameBytes === 0 ? { kind: "eof" } : { kind: "malformed" };

      try {
        // oxlint-disable-next-line no-await-in-loop
        const next = await this.#reader.read();
        if (next.done) this.#ended = true;
        else this.#chunk = next.value;
      } catch {
        return { kind: "stream-error" };
      }
    }
  }

  #append(bytes: Uint8Array, closesFrame: boolean): boolean {
    const total = this.#frameBytes + bytes.byteLength + Number(closesFrame);
    if (total > MAX_EXEC_FRAME_BYTES) return false;
    if (bytes.byteLength > 0) this.#parts.push(bytes);
    this.#frameBytes = total;
    return true;
  }

  #parseFrame(): FrameOutcome {
    const bytes = join(this.#parts, this.#frameBytes - 1);
    this.#parts = [];
    this.#frameBytes = 0;
    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      const value: unknown = JSON.parse(text);
      return { kind: "value", value };
    } catch {
      return { kind: "malformed" };
    }
  }
}
