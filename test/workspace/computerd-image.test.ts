import { expect, test } from "vitest";

import {
  GITHUB_CLI_CONFIG_DIRECTORY,
  GIT_GLOBAL_CONFIG_PATH,
  WORKSPACE_SYNC_IGNORES,
} from "../../src/workspace-layout.js";

declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { readonly eager: true; readonly query: "?raw"; readonly import: "default" },
    ) => Record<string, string>;
  }
}

/** Vite resolves both globs at build time, so this reads no filesystem and runs in workerd. */
const dockerfiles = import.meta.glob("../../containers/computerd.Dockerfile", {
  eager: true,
  query: "?raw",
  import: "default",
});

const dockerignores = import.meta.glob("../../.dockerignore", {
  eager: true,
  query: "?raw",
  import: "default",
});

const patches = import.meta.glob("../../containers/computerd-walk.patch", {
  eager: true,
  query: "?raw",
  import: "default",
});

const patch = Object.values(patches).at(0) ?? "";

const dockerfile = Object.values(dockerfiles).at(0) ?? "";

const dockerignore = Object.values(dockerignores).at(0) ?? "";

test("the workspace image's shim skips exactly the segments the sync ignores", () => {
  const setting = /^ENV COMPUTERD_WALK_IGNORE=(\S*)$/mu.exec(dockerfile)?.[1];

  expect(setting?.split(",")).toStrictEqual([...WORKSPACE_SYNC_IGNORES]);
});

test("the workspace image polls the disk every five seconds, not every 250 ms", () => {
  const setting = /^ENV COMPUTERD_POLL_MS=(\S*)$/mu.exec(dockerfile)?.[1];

  expect(setting).toBe("5000");
});

test("the walk patch reads COMPUTERD_POLL_MS and tests its parse", () => {
  expect(patch).toContain("COMPUTERD_POLL_MS");
  expect(patch).toContain("parsePollMs(");
  expect(patch).toContain("COMPUTERD_POLL_MS is unset, or one positive integer");
  expect(patch, "a value above the timer limit is refused, not clamped to 1 ms").toContain(
    "MAX_POLL_MS = 2_147_483_647",
  );
});

test("the workspace image keeps gh and Git global configuration in the durable workspace", () => {
  const setting = (name: string) => new RegExp(`^ENV ${name}=(\\S*)$`, "mu").exec(dockerfile)?.[1];

  expect(setting("COMPUTER_VAR_GH_CONFIG_DIR")).toBe(GITHUB_CLI_CONFIG_DIRECTORY);
  expect(setting("COMPUTER_VAR_GIT_CONFIG_GLOBAL")).toBe(GIT_GLOBAL_CONFIG_PATH);
});

test("the workspace image ships computerd built from source, not the prebuilt image", () => {
  expect(dockerfile).toMatch(/^FROM \S+ AS computerd$/mu);
  expect(dockerfile).toMatch(/^COPY --from=computerd \/usr\/local\/bin\/computerd /mu);
  expect(dockerfile).not.toMatch(/^FROM ghcr\.io\/cloudflare\/computer-computerd/mu);
  expect(dockerfile).toContain("git apply /tmp/computerd-walk.patch");
});

test("the build context admits every file the workspace image copies", () => {
  const admitted = new Set(
    dockerignore
      .split("\n")
      .filter((line) => line.startsWith("!"))
      .map((line) => line.slice(1)),
  );

  const copied = [...dockerfile.matchAll(/^COPY (?!--from)(.+) \S+$/gmu)].flatMap(
    (match) => match[1]?.split(" ") ?? [],
  );

  expect(copied.length).toBeGreaterThan(0);
  expect(copied.filter((source) => !admitted.has(source))).toStrictEqual([]);
});
