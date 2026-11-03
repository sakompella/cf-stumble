type Waiting = Readonly<{ bytes: Uint8Array; delivered: () => void }>;

export class PacedStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly #waiting: Waiting[] = [];
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  #pulled: (() => void) | undefined;

  constructor(onCancel: () => void) {
    this.readable = new ReadableStream<Uint8Array>(
      {
        start: (opened) => {
          this.#controller = opened;
        },
        pull: () =>
          new Promise<void>((resolve) => {
            this.#pulled = resolve;
            this.#flush();
          }),
        cancel: () => {
          this.#end();
          onCancel();
        },
      },
      { highWaterMark: 0 },
    );
  }

  send(bytes: Uint8Array): Promise<void> {
    if (this.#controller === undefined) return Promise.resolve();

    return new Promise<void>((delivered) => {
      this.#waiting.push({ bytes, delivered });
      this.#flush();
    });
  }

  sendIfIdle(bytes: Uint8Array): void {
    if (this.#pulled !== undefined && this.#waiting.length === 0) void this.send(bytes);
  }

  close(): void {
    this.#controller?.close();
    this.#end();
  }

  #flush(): void {
    const next = this.#pulled === undefined ? undefined : this.#waiting.shift();

    if (next === undefined) return;

    this.#pulled?.();
    this.#pulled = undefined;
    this.#controller?.enqueue(next.bytes);
    next.delivered();
  }

  #end(): void {
    this.#controller = undefined;
    this.#pulled?.();
    this.#pulled = undefined;
    this.#waiting.splice(0).forEach(({ delivered }) => {
      delivered();
    });
  }
}
