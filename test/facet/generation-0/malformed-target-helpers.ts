import type { ExecTarget } from "../../../src/facet/generation-0/execution-env-exec.js";
import type { ProjectRpcTargetContract } from "../../../src/workspace/project/protocol.js";

/**
 * Shared doubles for `execution-env-malformed.test.ts` and `execution-env-byte-framing.test.ts`.
 * Both files deliberately build targets that violate `ExecTarget`/`ProjectRpcTargetContract` at
 * runtime — a malformed envelope, a rejecting call, an `ok` field of the wrong shape, or bytes cut
 * at an arbitrary boundary — exactly the inputs this adapter's defensive parsing exists to handle.
 * A real caller's own types would refuse to construct these, so each helper takes the deliberately
 * malformed double as `unknown` and asserts it into the real contract type: that single hop from
 * `unknown` is what lets a test simulate a target (or an RPC hop) that lies about what it declared.
 */

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Deliberately untyped: this helper exists so a test can simulate a target that lies about its own contract.
export function asExecTarget(target: unknown): ExecTarget {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: deliberately violates the real contract; see the file-level comment above.
  return target as ExecTarget;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Deliberately untyped: this helper exists so a test can simulate a target that lies about its own contract.
export function asProjectTarget(target: unknown): ProjectRpcTargetContract {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: deliberately violates the real contract; see the file-level comment above.
  return target as ProjectRpcTargetContract;
}

/**
 * Encodes one raw exec-stream event the same way the real target's wire contract does: one
 * newline-terminated UTF-8 JSON frame. `value` is deliberately `unknown` — a test builds
 * adversarial payloads this adapter's own `ExecEvent` type would refuse to describe.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Deliberately untyped: encodes adversarial exec-event payloads a real `ExecEvent` could never hold.
function encodeFrame(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

/** One frame per array element — the wire contract's happy path, before any byte-level cutting. */
export function readableFrom(
  values: readonly unknown[],
  onLastRead?: () => void,
): ReadableStream<Uint8Array> {
  const frames = values.map((value) => encodeFrame(value));
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= frames.length) {
        onLastRead?.();
        controller.close();
        return;
      }
      controller.enqueue(frames[index]);
      index += 1;
    },
  });
}

export function rejectingReadable(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull() {
      return Promise.reject(new Error("stream broke"));
    },
  });
}

/** Delivers exactly the byte chunks given, letting a test control how frames are physically cut. */
export function readableFromChunks(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]);
      index += 1;
    },
  });
}
