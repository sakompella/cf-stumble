export function byteChunkStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;

  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[index];

      if (chunk === undefined) {
        controller.close();

        return;
      }

      controller.enqueue(chunk);
      index += 1;
    },
  });
}
