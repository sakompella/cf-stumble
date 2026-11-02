import { withoutAbortSignal, type Context } from "@earendil-works/chord/context";
import {
  ExecutionError,
  type FileError,
  type Result,
  type ShellSpillOptions,
} from "@earendil-works/pi-durable/env";
import type { ComputerWorkspace } from "./execution-env-paths.js";
import { createSpillFile, writeBytes } from "./execution-env-files.js";

const APPEND_CHARACTERS = 128 * 1024;

const encoder = new TextEncoder();

const kept: Result<void, ExecutionError> = { ok: true, value: undefined };

export class OutputSpill {
  readonly #workspace: ComputerWorkspace;
  readonly #thresholds: ShellSpillOptions;
  readonly #context: Context;
  #bytes = 0;
  #newlines = 0;
  #pending = "";
  #path: string | undefined;

  constructor(workspace: ComputerWorkspace, thresholds: ShellSpillOptions, context: Context) {
    this.#workspace = workspace;
    this.#thresholds = thresholds;
    this.#context = withoutAbortSignal(context);
  }

  async push(text: string): Promise<Result<void, ExecutionError>> {
    this.#pending += text;

    if (this.#path === undefined) {
      this.#bytes += encoder.encode(text).byteLength;
      this.#newlines += text.split("\n").length - 1;
      const lines = this.#newlines + (text.endsWith("\n") ? 0 : 1);

      if (this.#bytes <= this.#thresholds.afterBytes && lines <= this.#thresholds.afterLines) {
        return kept;
      }

      const created = await createSpillFile(this.#workspace);

      if (!created.ok) return spillFailure(created.error);

      this.#path = created.value;
    }

    return this.#pending.length < APPEND_CHARACTERS ? kept : this.#append(this.#path);
  }

  async finish(): Promise<Result<string | undefined, ExecutionError>> {
    if (this.#path === undefined) return { ok: true, value: undefined };

    const appended = await this.#append(this.#path);

    return appended.ok ? { ok: true, value: this.#path } : appended;
  }

  async #append(path: string): Promise<Result<void, ExecutionError>> {
    const text = this.#pending;
    this.#pending = "";

    if (text === "") return kept;

    const appended = await writeBytes(this.#workspace, path, text, "append", this.#context);

    return appended.ok ? kept : spillFailure(appended.error);
  }
}

function spillFailure(cause: FileError): Result<never, ExecutionError> {
  const message = `Failed to preserve complete shell output: ${cause.message}`;

  return { ok: false, error: new ExecutionError("unknown", message, cause) };
}
