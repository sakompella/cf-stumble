import { reset } from "cloudflare:test";
import * as Result from "effect/Result";
import { afterEach, expect, test } from "vitest";
import type { ModelCapability } from "../../../src/facet/conversation-protocol.js";
import { parseRequest, type AssistantMessage } from "../../../src/model-route-wire/request.js";
import { ok, type ProjectRpcTargetContract } from "../../../src/workspace/project/protocol.js";
import { eventually } from "../../eventually.js";
import { entriesText } from "./conversation-host.js";
import { inTurn } from "./route-failure-turn.js";
import { NO_USAGE, replies } from "./scripted-route.js";

afterEach(async () => {
  await reset();
});

type ToolCall = AssistantMessage["tool_calls"][number];

const ZEROS = new Uint8Array(50_000);

const unused = () => Promise.reject(new Error("not used"));

const workspace: ProjectRpcTargetContract & Disposable = {
  lstat: (path) =>
    Promise.resolve(
      ok({
        name: "data.bin",
        path,
        kind: "file",
        size: ZEROS.length,
        mtimeMs: 0,
        canonicalPath: ok(path),
      }),
    ),
  readFile: () => Promise.resolve(ok(ZEROS)),
  writeFile: unused,
  startExec: unused,
  kill: unused,
  endTurn: unused,
  [Symbol.dispose]: () => {},
};

const read = (index: number): ToolCall => ({
  id: `call_${index}`,
  function: { name: "read", arguments: JSON.stringify({ path: "data.bin" }) },
});

const says = (content: string | null, tool_calls: readonly ToolCall[] = []) =>
  replies([
    {
      type: "done",
      served: { provider: "workers-ai", model: "test-model" },
      message: { role: "assistant", content, tool_calls },
      usage: NO_USAGE,
    },
  ])();

function sizeCheckedRoute(): ModelCapability {
  let accepted = 0;

  return {
    runStream(request) {
      const parsed = parseRequest(request);

      if (Result.isFailure(parsed)) return Promise.resolve(parsed.failure);
      accepted += 1;

      const last = request.messages.at(-1);

      if (accepted === 1) return says(null, [0, 1, 2, 3].map(read));

      return says(last?.role === "user" && last.content === "go on" ? "recovered" : "summary");
    },
  };
}

test("reads of a binary file that push the request past the route's size limit are compacted away, and the next message answers", async () => {
  await inTurn(
    "request-size-limit",
    sizeCheckedRoute(),
    async ({ facet, id, reports }) => {
      await eventually(() => {
        expect(reports).toEqual(["model_error"]);
      });
      await facet.submit(id, "go on", "r2");
      await eventually(async () => {
        expect(reports).toEqual(["model_error"]);
        expect(await entriesText(facet, id)).toContain('"recovered"');
      });
    },
    { workspace: () => Promise.resolve(workspace) },
  );
}, 30_000);
