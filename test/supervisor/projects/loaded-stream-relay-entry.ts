import { WorkerEntrypoint } from "cloudflare:workers";

export default class LoadedStreamRelayEntry extends WorkerEntrypoint {
  relay(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    return stream;
  }
}
