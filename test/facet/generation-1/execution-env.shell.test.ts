import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  getOrThrow,
  type ExecutionEnv,
  type FileError,
  type FileErrorCode,
  type Result,
} from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import { withHostWorkspace } from "./host-workspace.js";

const context = BACKGROUND_CONTEXT;

describe("Computer ExecutionEnv exec", () => {
  it("keeps the complete output in a spill file once it passes a threshold", async () => {
    await withHostWorkspace(async (env) => {
      const lines = 20_000;
      const script = `i=0; while [ $i -lt ${lines} ]; do echo line-$i; i=$((i+1)); done`;
      const spill = { afterBytes: 1_000, afterLines: 100 };
      const result = getOrThrow(await env.exec(script, { spill }, context));
      const expected = Array.from({ length: lines }, (_, index) => `line-${index}\n`).join("");

      expect(result.exitCode).toBe(0);
      expect(getOrThrow(await env.readTextFile(result.spillPath ?? "", context))).toBe(expected);
    });
  });

  it("passes variables to the program and can clear the inherited environment", async () => {
    let stdout = "";

    await withHostWorkspace(async (env) => {
      const argv = ["/bin/sh", "-c", 'printf "%s|%s" "$GREETING" "${HOME-unset}"'];

      const result = await env.exec(
        argv,
        {
          env: { GREETING: "it's $HOME" },
          inheritEnv: false,
          onOutput: (text) => {
            stdout += text;
          },
        },
        context,
      );

      expect(getOrThrow(result).exitCode).toBe(0);
    });

    expect(stdout).toBe("it's $HOME|unset");
  });
});

function codeOf<T>(result: Result<T, FileError>): FileErrorCode | undefined {
  return result.ok ? undefined : result.error.code;
}

const UNSUPPORTED_CALLS: ReadonlyArray<
  readonly [string, (env: ExecutionEnv) => Promise<FileErrorCode | undefined>]
> = [
  ["readBinaryFile", async (env) => codeOf(await env.readBinaryFile("a", context))],
  ["appendFile", async (env) => codeOf(await env.appendFile("a", "x", context))],
  ["openTextLineReader", async (env) => codeOf(await env.openTextLineReader("a", context))],
  ["readTextLines", async (env) => codeOf(await env.readTextLines("a", undefined, context))],
  ["truncateFile", async (env) => codeOf(await env.truncateFile("a", 0, context))],
  ["flushFile", async (env) => codeOf(await env.flushFile("a", context))],
  ["renameFile", async (env) => codeOf(await env.renameFile("a", "b", context))],
  ["listDir", async (env) => codeOf(await env.listDir(".", context))],
  ["openDirReader", async (env) => codeOf(await env.openDirReader(".", context))],
  ["watch", async (env) => codeOf(await env.watch([{ path: "." }], () => {}, context))],
  ["createDir", async (env) => codeOf(await env.createDir("a", undefined, context))],
  ["remove", async (env) => codeOf(await env.remove("a", undefined, context))],
];

describe("Computer ExecutionEnv members Pi Durable never calls", () => {
  it.each(UNSUPPORTED_CALLS)("%s answers not_supported", async (_member, call) => {
    await withHostWorkspace(async (env) => {
      getOrThrow(await env.writeFile("a", "x", context));

      expect(await call(env)).toBe("not_supported");
    });
  });
});
