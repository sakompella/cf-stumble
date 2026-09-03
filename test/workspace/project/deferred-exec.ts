import type { ExecBackendHandle } from "../../../src/workspace/project/index.js";
import { ManualExecHandle } from "./fakes.js";

/**
 * A backend `exec()` call a test holds open by hand: `handle` is the eventual
 * `ManualExecHandle`, and `resolve`/`reject` settle the promise `FakeExecBackend.exec()` returned
 * for it, the way a slow or failing real backend eventually would.
 */
export interface DeferredExec {
  readonly handle: ManualExecHandle;
  readonly promise: Promise<ExecBackendHandle>;
  resolve(): void;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Test fake: simulates whatever error shape a real backend's `exec()` rejection would carry.
  reject(error: unknown): void;
}

/** Creates one pending `exec()` outcome a test settles later, to simulate a slow or failing backend handle creation. */
export function deferredExec(): DeferredExec {
  const handle = new ManualExecHandle();
  let resolveImpl!: (handle: ManualExecHandle) => void;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Test fake: simulates whatever error shape a real backend's `exec()` rejection would carry.
  let rejectImpl!: (error: unknown) => void;
  const promise = new Promise<ExecBackendHandle>((resolve, reject) => {
    resolveImpl = resolve;
    rejectImpl = reject;
  });
  return {
    handle,
    promise,
    resolve: () => {
      resolveImpl(handle);
    },
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Test fake: simulates whatever error shape a real backend's `exec()` rejection would carry.
    reject: (error: unknown) => {
      rejectImpl(error);
    },
  };
}
