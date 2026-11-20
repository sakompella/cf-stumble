import type { Workspace } from "@cloudflare/computer";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { expect, test } from "vitest";
import { createComputerEnv } from "../../../src/facet/generation-1/execution-env.js";
import { WORKSPACE_OUTPUT_OPTIONS } from "../../../infra/worker-settings.js";
import { unscriptedGenerations } from "../../facet/generation-1/generation-control.js";
import { withDecodedEvents, type ExecEvent } from "./decoded-events.js";
import { chunkLines, inWorkspace } from "./echoing-container.js";

type Run = Readonly<{ events: ExecEvent[]; saved: string }>;

async function readdirOutcome(workspace: Workspace): Promise<string> {
  try {
    await workspace.fs.readdir(WORKSPACE_OUTPUT_OPTIONS.dir);

    return "lists";
  } catch (error) {
    return error instanceof Error && "code" in error
      ? `${error.name} ${String(error.code)}`
      : "unexpected";
  }
}

function runEcho(stdout: readonly string[]): Promise<Run> {
  return inWorkspace(stdout, async (workspace, target) => {
    const started = await withDecodedEvents(target).startExec({ command: "echo" });

    if (!started.ok) throw new Error(JSON.stringify(started));

    const events: ExecEvent[] = [];

    for await (const event of started.value.events) events.push(event);

    return { events, saved: await readdirOutcome(workspace) };
  });
}

function stdoutOf(events: readonly ExecEvent[]): string {
  return events.flatMap((event) => (event.kind === "stdout" ? [event.data] : [])).join("");
}

test("a long command's full output is kept once, in the env's spill file", async () => {
  const lines = Array.from({ length: 3_000 }, (_, index) => `line-${index}\n`);
  const text = lines.join("");

  const kept = await inWorkspace(chunkLines(lines, 100), async (workspace, target) => {
    const computerEnv = createComputerEnv({
      cwd: "/workspace/project",
      target,
      generations: unscriptedGenerations,
    });

    const seen: string[] = [];

    const result = getOrThrow(
      await computerEnv.exec(
        "echo",
        {
          spill: { afterBytes: 50 * 1024, afterLines: 2_000 },
          onOutput: (data) => {
            seen.push(data);
          },
        },
        BACKGROUND_CONTEXT,
      ),
    );

    const read = getOrThrow(
      await computerEnv.readTextFile(result.spillPath ?? "", BACKGROUND_CONTEXT),
    );

    const saved = await readdirOutcome(workspace);

    return {
      streamed: seen.join(""),
      spillPath: result.spillPath,
      spilledText: read,
      saved,
    };
  });

  expect(kept.streamed).toBe(text);
  expect(kept.spillPath).toMatch(/^\/workspace\/\.cf-stumble\/tmp\/pi-output-/u);
  expect(kept.spilledText).toBe(text);
  expect(kept.saved).toBe("WorkspaceFsError ENOENT");
});

test("output that fits the limits is delivered whole and saves nothing", async () => {
  const { events, saved } = await runEcho(["hello\n", "world\n"]);

  expect(events.at(-1)).toMatchObject({ kind: "terminal", outcome: "exited", exitCode: 0 });
  expect(stdoutOf(events)).toBe("hello\nworld\n");

  expect(saved).toBe("WorkspaceFsError ENOENT");
});
