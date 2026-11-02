import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { expect, test } from "vitest";
import { resolveAddressedPath } from "../../../src/workspace/project/resolve.js";
import { FakeProjectFilesystemProvider } from "./fakes.js";

const SLOTS = ["/workspace/a", "/workspace/b", "/workspace/d", "/workspace/d/e"];

const TARGETS = [
  "a",
  "d",
  "d/e",
  "e",
  "./a",
  "..",
  "../a",
  "../workspaceevil",
  "../workspaceevil/x",
  "/",
  "/etc",
  "/workspace/a",
  "/workspace/d/e",
  "/workspaceevil",
  "/workspaceevil/x",
];

const ERROR_CODES = ["not-found", "not-directory", "path-outside-root", "symlink-loop"];

function isInsideRoot(path: string): boolean {
  return (
    path === "/workspace" || (path.startsWith("/workspace/") && posix.normalize(path) === path)
  );
}

function providerWithGraph(tc: hegel.TestCase): FakeProjectFilesystemProvider {
  const provider = new FakeProjectFilesystemProvider();
  provider.addDirectory("/");
  provider.addDirectory("/etc");
  provider.addDirectory("/workspaceevil");
  provider.addFile("/workspaceevil/x", new Uint8Array([1]));

  for (const slot of SLOTS) {
    if (provider.nodes.get(posix.dirname(slot))?.type !== "dir") continue;
    const kind = tc.draw(gs.sampledFrom(["absent", "directory", "file", "symlink"]));

    if (kind === "directory") provider.addDirectory(slot);

    if (kind === "file") provider.addFile(slot, new Uint8Array([0]));

    if (kind === "symlink") provider.addSymlink(slot, tc.draw(gs.sampledFrom(TARGETS)));
  }

  return provider;
}

test("resolving any path through any symlink graph touches and returns only paths inside the workspace", () => {
  hegel.test(
    (tc) => {
      const provider = providerWithGraph(tc);

      const segments = tc.draw(
        gs.arrays(gs.sampledFrom(["a", "b", "d", "e", "x"]), { minSize: 1, maxSize: 3 }),
      );

      const options = {
        followFinalSymlink: tc.draw(gs.booleans()),
        createMissingDirs: tc.draw(gs.booleans()),
      };

      const outcome = resolveAddressedPath(provider, segments, options);
      const touched = provider.calls.map((call) => call.slice(call.indexOf(":") + 1));

      expect(touched.filter((path) => !isInsideRoot(path))).toEqual([]);

      if (!outcome.ok) {
        expect(ERROR_CODES).toContain(outcome.error.code);
      } else if (outcome.value.kind === "resolved") {
        expect(isInsideRoot(outcome.value.path)).toBe(true);
      } else {
        expect(isInsideRoot(outcome.value.parentPath)).toBe(true);
      }
    },
    { testCases: 500 },
  );
});

function realDirectoryOf(provider: FakeProjectFilesystemProvider): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "resolve-props-")));

  for (const [path, node] of [...provider.nodes].toSorted(([a], [b]) => a.length - b.length)) {
    const real = join(root, path);

    if (node.type === "dir") mkdirSync(real, { recursive: true });

    if (node.type === "file") writeFileSync(real, node.data);

    if (node.type === "symlink") {
      symlinkSync(node.target.startsWith("/") ? join(root, node.target) : node.target, real);
    }
  }

  return root;
}

function realPathInside(root: string, path: string): string | undefined {
  try {
    const real = realpathSync(join(root, path));
    const relative = real.slice(root.length);

    return real.startsWith(root) && isInsideRoot(relative) ? relative : undefined;
  } catch {
    return undefined;
  }
}

test("a path resolves exactly when the kernel resolves it inside the workspace, to the same place", () => {
  hegel.test(
    (tc) => {
      const provider = providerWithGraph(tc);

      const segments = tc.draw(
        gs.arrays(gs.sampledFrom(["a", "b", "d", "e", "x"]), { minSize: 1, maxSize: 3 }),
      );

      const root = realDirectoryOf(provider);

      try {
        const outcome = resolveAddressedPath(provider, segments, {
          followFinalSymlink: true,
          createMissingDirs: false,
        });

        const resolved =
          outcome.ok && outcome.value.kind === "resolved" ? outcome.value.path : undefined;

        expect(resolved).toBe(realPathInside(root, `/workspace/${segments.join("/")}`));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    { testCases: 1_000 },
  );
});
