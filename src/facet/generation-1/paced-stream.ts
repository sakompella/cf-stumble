export type PacedStream = Readonly<{
  readable: ReadableStream<Uint8Array>;
  send(bytes: Uint8Array): Promise<void>;
  sendIfIdle(bytes: Uint8Array): void;
  close(): void;
}>;

export function pacedStream(onCancel: () => void): PacedStream {
  const waiting: { bytes: Uint8Array; delivered: () => void }[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let pulled: (() => void) | undefined;

  const flush = () => {
    const next = pulled === undefined ? undefined : waiting.shift();

    if (next === undefined) return;

    const done = pulled;

    pulled = undefined;
    controller?.enqueue(next.bytes);
    done?.();
    next.delivered();
  };

  const send = (bytes: Uint8Array) =>
    new Promise<void>((delivered) => {
      waiting.push({ bytes, delivered });
      flush();
    });

  const readable = new ReadableStream<Uint8Array>(
    {
      start: (opened) => {
        controller = opened;
      },
      pull: () =>
        new Promise<void>((resolve) => {
          pulled = resolve;
          flush();
        }),
      cancel: () => {
        pulled = undefined;
        controller = undefined;
        waiting.splice(0).forEach(({ delivered }) => {
          delivered();
        });
        onCancel();
      },
    },
    { highWaterMark: 0 },
  );

  return {
    readable,
    send,
    sendIfIdle: (bytes) => {
      if (pulled !== undefined && waiting.length === 0) void send(bytes);
    },
    close: () => {
      controller?.close();
    },
  };
}
