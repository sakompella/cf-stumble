export function byteChunkStream(
  chunks: readonly Uint8Array[],
  onExhausted?: () => void,
): ReadableStream<Uint8Array> {
  let index = 0;
  let exhausted = false;

  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[index];

      if (chunk === undefined) {
        if (!exhausted) {
          exhausted = true;
          onExhausted?.();
        }

        controller.close();

        return;
      }

      controller.enqueue(chunk);
      index += 1;
    },
  });
}
