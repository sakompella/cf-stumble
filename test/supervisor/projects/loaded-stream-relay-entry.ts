import { WorkerEntrypoint } from "cloudflare:workers";

/**
 * Test-only Worker Loader entrypoint that hands a stream straight back across a real RPC hop, the
 * way the Worker hands the Supervisor's turn stream to a browser. A stream read through this hop
 * is the receiving end of a pipe, so cancelling it behaves as a browser that went away does: the
 * stream's source hears of it only when it next writes.
 */
export default class LoadedStreamRelayEntry extends WorkerEntrypoint {
  relay(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    return stream;
  }
}
