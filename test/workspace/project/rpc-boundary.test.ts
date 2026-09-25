import { expect, test } from "vitest";
import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import {
  FakeExecBackend,
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
} from "./fakes.js";

/**
 * The project target crosses the Workspace Host RPC boundary. These checks pin the values before
 * structured clone strips prototypes, so an accidental class instance cannot be mistaken for a
 * plain RPC result. The loaded execution-environment tests cover the same target through a real
 * Workers RPC hop.
 */

function makeTarget() {
  const provider = new FakeProjectFilesystemProvider();
  const execBackend = new FakeExecBackend();
  const target = new ProjectRpcTarget(provider, new FakeProjectTransactions(), execBackend);

  return { provider, execBackend, target };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Test helper: asserts an RPC return value is a plain clonable object, whatever its shape.
function assertPlainlyCloneable(value: unknown): void {
  expect(structuredClone(value)).toStrictEqual(value);

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Test helper: checking whether an already-untyped value is an object before inspecting its prototype.
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) {
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  }
}

test("every ProjectResult is a plain, structured-clone-safe value", async () => {
  const { provider, target } = makeTarget();
  provider.addFile("/workspace/f.txt", new TextEncoder().encode("hi"));

  assertPlainlyCloneable(await target.lstat("/missing"));
  assertPlainlyCloneable(await target.lstat("/f.txt"));
  assertPlainlyCloneable(await target.readFile("/missing"));
  assertPlainlyCloneable(await target.readFile("/f.txt"));
  assertPlainlyCloneable(
    await target.writeFile("/f.txt", new TextEncoder().encode("y"), "overwrite"),
  );
  assertPlainlyCloneable(await target.listFiles("/"));
  assertPlainlyCloneable(await target.kill("not-well-formed"));
});

test("every startExec stream event is a structured-clone-safe byte frame", async () => {
  const { execBackend, target } = makeTarget();
  const started = await target.startExec({ command: "echo hi" });

  if (!started.ok) throw new Error("expected startExec to succeed");
  assertPlainlyCloneable({ operationId: started.value.operationId });

  const handle = execBackend.handles[0]!;
  const encoded = new TextEncoder().encode("hi\n");
  handle.push({ name: "stdout", data: encoded });
  // oxlint-disable-next-line unicorn/prefer-single-call -- `push` here queues one exec event per call, not array elements to merge.
  handle.push({ name: "exit", exitCode: 0 });

  const reader = started.value.events.getReader();

  for (;;) {
    const next = await reader.read();

    if (next.done) break;
    assertPlainlyCloneable(next.value);
    expect(next.value).toBeInstanceOf(Uint8Array);
    expect(() => {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(next.value));

      return parsed;
    }).not.toThrow();
  }
});
