export type LineOutcome =
  | { readonly kind: "line"; readonly text: string }
  | { readonly kind: "too-long" }
  | { readonly kind: "truncated" }
  | { readonly kind: "undecodable" }
  | { readonly kind: "eof" }
  | { readonly kind: "stream-error" };

const NEWLINE = 10;

function newlineIndex(bytes: Uint8Array, start: number): number {
  for (let index = start; index < bytes.byteLength; index++) {
    if (bytes[index] === NEWLINE) return index;
  }

  return -1;
}

function join(parts: readonly Uint8Array[], length: number): Uint8Array {
  const line = new Uint8Array(length);
  let offset = 0;

  for (const part of parts) {
    line.set(part, offset);
    offset += part.byteLength;
  }

  return line;
}

export class LineReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #maxBytes: number;
  #chunk: Uint8Array | undefined;
  #offset = 0;
  #parts: Uint8Array[] = [];
  #lineBytes = 0;
  #ended = false;

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>, maxBytes: number) {
    this.#reader = reader;
    this.#maxBytes = maxBytes;
  }

  cancel(): void {
    void this.#reader.cancel().catch(() => {});
  }

  async next(): Promise<LineOutcome> {
    for (;;) {
      const chunk = this.#chunk;

      if (chunk !== undefined) {
        const newline = newlineIndex(chunk, this.#offset);
        const end = newline === -1 ? chunk.byteLength : newline;

        if (!this.#append(chunk.subarray(this.#offset, end), newline !== -1)) {
          return { kind: "too-long" };
        }

        this.#offset = newline === -1 ? chunk.byteLength : newline + 1;

        if (this.#offset === chunk.byteLength) {
          this.#chunk = undefined;
          this.#offset = 0;
        }

        if (newline !== -1) return this.#line();
        continue;
      }

      if (this.#ended) return this.#lineBytes === 0 ? { kind: "eof" } : { kind: "truncated" };

      try {
        const next = await this.#reader.read();

        if (next.done) this.#ended = true;
        else this.#chunk = next.value;
      } catch {
        return { kind: "stream-error" };
      }
    }
  }

  #append(bytes: Uint8Array, closesLine: boolean): boolean {
    const total = this.#lineBytes + bytes.byteLength + Number(closesLine);

    if (total > this.#maxBytes) return false;

    if (bytes.byteLength > 0) this.#parts.push(bytes);
    this.#lineBytes = total;

    return true;
  }

  #line(): LineOutcome {
    const bytes = join(this.#parts, this.#lineBytes - 1);
    this.#parts = [];
    this.#lineBytes = 0;

    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);

      return { kind: "line", text };
    } catch {
      return { kind: "undecodable" };
    }
  }
}
