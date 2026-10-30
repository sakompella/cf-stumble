export type BackendExecEvent =
  | { name: "stdout"; data: Uint8Array }
  | { name: "stderr"; data: Uint8Array }
  | { name: "exit"; exitCode: number };

interface ExecBackendReader {
  read(): Promise<{ done: false; value: BackendExecEvent } | { done: true; value?: undefined }>;
  cancel(): Promise<void>;
}

/** Exposes only an incremental reader and `kill`, never a buffered `result()`: stdout must be forwarded as it arrives. */
export interface ExecBackendHandle {
  readonly reader: ExecBackendReader;
  kill(): Promise<void>;
}

export interface ExecBackendInput {
  command: string;
  cwd: string;
  timeoutMs: number;
}

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
