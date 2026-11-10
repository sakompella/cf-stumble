import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Result from "effect/Result";
import { posix } from "node:path";
import { expect, test } from "vitest";

import {
  fromAddressed,
  resolveInWorkspace,
} from "../../src/facet/generation-1/execution-env-paths.js";
import { parseAddressedPath } from "../../src/workspace/project/resolve.js";

const segment = gs.sampledFrom([
  "a",
  "b",
  ".",
  "..",
  "",
  "workspace",
  "workspace-x",
  "workspace-evil",
  "é",
  "日",
  "🙂",
]);

const cwdSegment = gs.sampledFrom(["a", "b", "workspace-x", "é", "日", "🙂"]);

test("resolveInWorkspace agrees with POSIX containment for generated paths", () => {
  hegel.test((tc) => {
    const cwdSuffix = tc.draw(gs.arrays(cwdSegment, { maxSize: 4 })).join("/");
    const cwd = posix.resolve("/workspace", cwdSuffix);
    const pathSegments = tc.draw(gs.arrays(segment, { maxSize: 7 }));
    const path = pathSegments.join("/");
    const input = tc.draw(gs.booleans()) ? `/${path}` : path;
    const expected = posix.resolve(cwd, input);
    const inside = expected === "/workspace" || expected.startsWith("/workspace/");
    const actual = resolveInWorkspace(cwd, input);

    expect(actual.ok).toBe(inside);

    if (actual.ok) expect(actual.value.absolute).toBe(expected);
  });
});

test("addressed paths round-trip and remain valid project addresses", () => {
  hegel.test((tc) => {
    const suffix = tc
      .draw(gs.arrays(gs.sampledFrom(["a", "workspace-x", "é", "日", "🙂"]), { maxSize: 7 }))
      .join("/");

    const canonical = posix.resolve("/workspace", suffix);
    const resolved = resolveInWorkspace("/workspace", canonical);

    expect(resolved).toMatchObject({ ok: true, value: { absolute: canonical } });

    if (!resolved.ok) return;

    const { addressed } = resolved.value;

    expect(fromAddressed(addressed)).toEqual(resolved.value);
    expect(Result.isSuccess(parseAddressedPath(addressed))).toBe(true);
  });
});
