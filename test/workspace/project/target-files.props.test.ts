import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import type { WriteMode } from "../../../src/workspace/project/protocol.js";
import { makeTarget } from "./target-helpers.js";

const PATHS = ["/a.bin", "/dir/b.bin", "/dir/sub/c.bin"];

const MODES: readonly WriteMode[] = ["overwrite", "append", "create-exclusive"];

const write = gs.tuples(
  gs.sampledFrom(PATHS),
  gs.sampledFrom(MODES),
  gs.binary({ maxSize: 24 }).map((bytes) => Uint8Array.from(bytes)),
);

function concat(head: Uint8Array, tail: Uint8Array): Uint8Array {
  const joined = new Uint8Array(head.byteLength + tail.byteLength);
  joined.set(head, 0);
  joined.set(tail, head.byteLength);

  return joined;
}

function modelAnswer(
  model: Map<string, Uint8Array>,
  path: string,
  mode: WriteMode,
  bytes: Uint8Array,
): string {
  const existing = model.get(path);

  if (mode === "create-exclusive" && existing !== undefined) return "already-exists";
  model.set(path, mode === "append" && existing !== undefined ? concat(existing, bytes) : bytes);

  return "ok";
}

test("writes that arrive together apply in call order: each path reads back as overwrite, append and exclusive create say", async () => {
  await hegel.testAsync(
    async (tc) => {
      const writes = tc.draw(gs.arrays(write, { maxSize: 12 }));
      const { target } = makeTarget();
      const model = new Map<string, Uint8Array>();

      const answers = await Promise.all(
        writes.map(([path, mode, bytes]) => target.writeFile(path, bytes, mode)),
      );

      expect(answers.map((answer) => (answer.ok ? "ok" : answer.error.code))).toEqual(
        writes.map(([path, mode, bytes]) => modelAnswer(model, path, mode, bytes)),
      );

      for (const path of PATHS) {
        const content = model.get(path);
        const read = await target.readFile(path);
        const info = await target.lstat(path);

        if (content === undefined) {
          expect(read).toEqual({ ok: false, error: { code: "not-found", path } });
        } else {
          expect(read).toEqual({ ok: true, value: content });
          expect(info).toMatchObject({
            ok: true,
            value: { kind: "file", path, size: content.byteLength },
          });
        }
      }
    },
    { testCases: 200 },
  );
});

const MALFORMATIONS = {
  relative: (segments: readonly string[]) => segments.join("/"),
  "a backslash": (segments: readonly string[]) => `/${segments.join("\\")}\\x`,
  "a NUL byte": (segments: readonly string[]) => `/${segments.join("/")}\u0000`,
  "a dot-dot segment": (segments: readonly string[]) => `/${[...segments, "..", "x"].join("/")}`,
  "a dot segment": (segments: readonly string[]) => `/${[".", ...segments].join("/")}`,
  "an empty segment": (segments: readonly string[]) => `/${segments.join("//")}//x`,
  "a trailing slash": (segments: readonly string[]) => `/${segments.join("/")}/`,
};

test("every call refuses a malformed path with invalid-request and leaves the workspace as it was", async () => {
  await hegel.testAsync(async (tc) => {
    const segments = tc.draw(
      gs.arrays(gs.text({ alphabet: "ab", minSize: 1, maxSize: 3 }), { minSize: 1, maxSize: 3 }),
    );

    const malform = tc.draw(gs.sampledFrom(Object.values(MALFORMATIONS)));
    const path = malform(segments);
    tc.note(JSON.stringify(path));
    const { provider, execBackend, target } = makeTarget();
    const before = [...provider.nodes.keys()];

    const answers = await Promise.all([
      target.lstat(path),
      target.readFile(path),
      target.writeFile(path, new Uint8Array([1]), "overwrite"),
      target.startExec({ command: "true", cwd: path }),
    ]);

    expect(answers).toEqual(answers.map(() => ({ ok: false, error: { code: "invalid-request" } })));
    expect([...provider.nodes.keys()]).toEqual(before);
    expect(execBackend.requests).toEqual([]);
  });
});
