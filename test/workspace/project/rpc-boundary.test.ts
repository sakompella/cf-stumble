import { expect, test } from "vitest";
import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import type { ProjectLstatInfo, ProjectResult } from "../../../src/workspace/project/protocol.js";
import {
  FakeExecBackend,
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
} from "./fakes.js";

function makeTarget() {
  const provider = new FakeProjectFilesystemProvider();
  const execBackend = new FakeExecBackend();
  const target = new ProjectRpcTarget(provider, new FakeProjectTransactions(), execBackend);

  return { provider, execBackend, target };
}

type CloneCandidate =
  | ProjectResult<ProjectLstatInfo | Uint8Array | null>
  | Uint8Array
  | Readonly<{ operationId: string }>;

function assertPlainlyCloneable(value: CloneCandidate): void {
  expect(structuredClone(value)).toStrictEqual(value);

  if (!(value instanceof Uint8Array)) {
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
  assertPlainlyCloneable(await target.kill("not-well-formed"));
});

test("every startExec stream event is a structured-clone-safe byte frame", async () => {
  const { execBackend, target } = makeTarget();
  const started = await target.startExec({ command: "echo hi" });

  if (!started.ok) throw new Error("expected startExec to succeed");
  assertPlainlyCloneable({ operationId: started.value.operationId });

  const handle = execBackend.handles[0]!;
  const encoded = new TextEncoder().encode("hi\n");
  handle.push({ name: "stdout", data: encoded }, { name: "exit", exitCode: 0 });

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
