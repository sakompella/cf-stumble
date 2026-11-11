import type { ExecBackendChoice } from "./protocol.js";

export type BackendExecEvent =
  | { name: "stdout"; data: Uint8Array }
  | { name: "stderr"; data: Uint8Array }
  | { name: "exit"; exitCode: number; fullOutputPaths?: readonly string[] | undefined };

interface ExecBackendReader {
  read(): Promise<{ done: false; value: BackendExecEvent } | { done: true; value?: undefined }>;
  cancel(): Promise<void>;
}

export interface ExecBackendHandle {
  readonly reader: ExecBackendReader;
  kill(): Promise<void>;
  readonly backend: ExecBackendChoice;
  readonly fellBackFrom?: "isolate" | undefined;
  readonly isolateRefused?: boolean | undefined;
}

export interface ExecBackendInput {
  command: string;
  cwd: string;
  timeoutMs: number;
  backend?: ExecBackendChoice | undefined;
}

export const ISOLATE_BACKEND_ID = "worker-shell";

export const CONTAINER_BACKEND_ID = "container-shell";

export interface ContainerLifecycleState {
  readonly generation: number;
}

export interface ExecBackend {
  exec(input: ExecBackendInput): Promise<ExecBackendHandle>;
}

export class ContainerRestartedError extends Error {
  readonly code = "container-restarted" as const;

  constructor() {
    super("container restarted");
  }
}

export function isContainerRestartedError(error: unknown): error is ContainerRestartedError {
  return error instanceof ContainerRestartedError;
}
