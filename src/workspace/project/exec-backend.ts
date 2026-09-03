/** One raw event from an executing command, before this target reframes it as an `ExecEvent`. */
export type BackendExecEvent =
  | { name: "stdout"; data: Uint8Array }
  | { name: "stderr"; data: Uint8Array }
  | { name: "exit"; exitCode: number };

/** A minimal, `ReadableStreamDefaultReader`-shaped pull interface over `BackendExecEvent`s. */
export interface ExecBackendReader {
  read(): Promise<{ done: false; value: BackendExecEvent } | { done: true; value?: undefined }>;
  cancel(): Promise<void>;
}

/**
 * A live command execution. Deliberately exposes only an incremental reader and `kill`, never a
 * buffered `result()`: this target must forward stdout as it arrives rather than waiting for the
 * command to finish.
 */
export interface ExecBackendHandle {
  readonly reader: ExecBackendReader;
  kill(): Promise<void>;
}

export interface ExecBackendInput {
  command: string;
  cwd: string;
  timeoutMs: number;
}

/** The narrow slice of Computer's runtime this target needs to start a command. */
export interface ExecBackend {
  exec(input: ExecBackendInput): Promise<ExecBackendHandle>;
}
