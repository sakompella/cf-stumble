import { expect, test } from "vitest";
import {
  computerExecBackend,
  processGroupCommand,
} from "../../../src/workspace/project/computer-adapter.js";

test("wraps a command in a session leader that kills the whole process group", () => {
  const wrapped = processGroupCommand("sleep 1 && printf '%s' \"done\"");

  expect(wrapped).toContain("exec setsid /bin/sh -c");
  expect(wrapped).toContain("kill -TERM -- -$$");
  expect(wrapped).toContain("sleep 1 && printf");
});

test("marks an in-flight read as container-restarted after the runtime generation changes", async () => {
  let resolveRead: ((value: { done: boolean }) => void) | undefined;
  const state = { generation: 0 };

  const runtime = {
    exec: () =>
      Promise.resolve({
        getReader: () => ({
          read: () =>
            new Promise<{ done: boolean }>((resolve) => {
              resolveRead = resolve;
            }),
          cancel: () => Promise.resolve(),
        }),
        kill: () => Promise.resolve(),
      }),
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: this fake implements the runtime slice used by this adapter.

  const backend = computerExecBackend(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: this fake implements the runtime slice used by this adapter.
    { runtime } as never,
    "container-shell",
    state,
  );

  const handle = await backend.exec({ command: "sleep 1", cwd: "/workspace", timeoutMs: 100 });
  const read = handle.reader.read();
  state.generation = 1;
  resolveRead?.({ done: false });

  await expect(read).rejects.toMatchObject({ code: "container-restarted" });
});
