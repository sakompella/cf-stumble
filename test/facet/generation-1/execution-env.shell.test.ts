import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
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
