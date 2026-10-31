import type { ExecBackendHandle } from "../../../src/workspace/project/exec-backend.js";
import { ManualExecHandle } from "./fakes.js";

export interface DeferredExec {
  readonly handle: ManualExecHandle;
  readonly promise: Promise<ExecBackendHandle>;
  resolve(): void;
  reject(error: Error): void;
}

export function deferredExec(): DeferredExec {
  const handle = new ManualExecHandle();
  let resolveImpl!: (handle: ManualExecHandle) => void;
  let rejectImpl!: (error: Error) => void;

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
    reject: (error: Error) => {
      rejectImpl(error);
    },
  };
}
