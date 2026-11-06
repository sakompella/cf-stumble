import type { WorkspaceRuntimeEvent } from "@cloudflare/computer";
import { expect, test } from "vitest";
import {
  computerExecBackend,
  processGroupCommand,
} from "../../../src/workspace/project/computer-adapter.js";
import { CONTAINER_BACKEND_ID } from "../../../src/workspace/project/exec-backend.js";

test("wraps a command in a session leader that kills the whole process group", () => {
  const wrapped = processGroupCommand("sleep 1 && printf '%s' \"done\"");

  expect(wrapped).toContain("exec setsid /bin/sh -c");
  expect(wrapped).toContain("& wait $!");
  expect(wrapped).toContain("kill -s KILL 0");
  expect(wrapped).toContain("sleep 1 && printf");
});

test("marks an in-flight read as container-restarted after the runtime generation changes", async () => {
  let resolveRead: ((value: { done: false; value: WorkspaceRuntimeEvent }) => void) | undefined;
  const state = { generation: 0 };

  const runtime = {
    exec: () =>
      Promise.resolve({
        getReader: () => ({
          read: () =>
            new Promise<{ done: false; value: WorkspaceRuntimeEvent }>((resolve) => {
              resolveRead = resolve;
            }),
          cancel: () => Promise.resolve(),
        }),
        kill: () => Promise.resolve(),
      }),
  };

  const backend = computerExecBackend({ runtime }, CONTAINER_BACKEND_ID, state);

  const handle = await backend.exec({ command: "sleep 1", cwd: "/workspace", timeoutMs: 100 });
  const read = handle.reader.read();
  state.generation = 1;
  resolveRead?.({
    done: false,
    value: { id: "1", seq: 0, name: "stdout", value: new Uint8Array() },
  });

  await expect(read).rejects.toMatchObject({ code: "container-restarted" });
});

test("reports a container restart that happens while the exit waits for the post-command sync", async () => {
  const state = { generation: 0 };

  const events: ({ done: true } | { done: false; value: WorkspaceRuntimeEvent })[] = [
    { done: false, value: { id: "1", seq: 0, name: "exit", code: 0 } },
  ];

  const runtime = {
    exec: () =>
      Promise.resolve({
        getReader: () => ({
          read: () => {
            const next = events.shift();

            if (next !== undefined) return Promise.resolve(next);

            state.generation = 1;

            return Promise.resolve({ done: true as const });
          },
          cancel: () => Promise.resolve(),
        }),
        kill: () => Promise.resolve(),
      }),
  };

  const backend = computerExecBackend({ runtime }, CONTAINER_BACKEND_ID, state);

  const handle = await backend.exec({ command: "true", cwd: "/workspace", timeoutMs: 100 });

  await expect(handle.reader.read()).rejects.toMatchObject({ code: "container-restarted" });
});
