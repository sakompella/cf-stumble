import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { posix } from "node:path";
import { expect, test } from "vitest";

import {
  fromAddressedPath,
  resolveAbsolute,
  toAddressedPath,
} from "../../src/facet/generation-0/execution-env-paths.js";
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

test("resolveAbsolute agrees with POSIX containment for generated paths", () => {
  hegel.test((tc) => {
    const cwdSuffix = tc.draw(gs.arrays(cwdSegment, { maxSize: 4 })).join("/");
    const cwd = posix.resolve("/workspace", cwdSuffix);
    const pathSegments = tc.draw(gs.arrays(segment, { maxSize: 7 }));
    const path = pathSegments.join("/");
    const input = tc.draw(gs.booleans()) ? `/${path}` : path;
    const expected = posix.resolve(cwd, input);
    const inside = expected === "/workspace" || expected.startsWith("/workspace/");
    const actual = resolveAbsolute(cwd, input);

    expect(actual.ok).toBe(inside);

    if (actual.ok) expect(actual.value).toBe(expected);
  });
});

test("addressed paths round-trip and remain valid project addresses", () => {
  hegel.test((tc) => {
    const suffix = tc
      .draw(gs.arrays(gs.sampledFrom(["a", "workspace-x", "é", "日", "🙂"]), { maxSize: 7 }))
      .join("/");

    const canonical = posix.resolve("/workspace", suffix);
    const resolved = resolveAbsolute("/workspace", canonical);

    expect(resolved).toEqual({ ok: true, value: canonical });

    if (!resolved.ok) return;

    const addressed = toAddressedPath(resolved.value);

    expect(fromAddressedPath(addressed)).toBe(resolved.value);
    expect(parseAddressedPath(addressed).ok).toBe(true);
  });
});
