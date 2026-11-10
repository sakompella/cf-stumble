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

const BUILD_CONTEXT = "../../infra/workspace-image/";

const contextFiles = import.meta.glob("../../infra/workspace-image/*", {
  eager: true,
  query: "?raw",
  import: "default",
});

const dockerfile = contextFiles[`${BUILD_CONTEXT}computerd.Dockerfile`] ?? "";

const dockerEnv = (name: string) => new RegExp(`^ENV ${name}=(\\S*)$`, "mu").exec(dockerfile)?.[1];

test("the workspace image's shim skips exactly the segments the sync ignores", () => {
  const setting = /^ENV COMPUTERD_WALK_IGNORE=(\S*)$/mu.exec(dockerfile)?.[1];

  expect(setting?.split(",")).toStrictEqual([...WORKSPACE_SYNC_IGNORES]);
});

test("the workspace image does not poll the disk every 250 ms", () => {
  const interval = Number(dockerEnv("COMPUTERD_POLL_MS"));

  expect(interval).toBeGreaterThanOrEqual(1_000);
});

test("the workspace image keeps gh and Git global configuration in the durable workspace", () => {
  expect(dockerEnv("COMPUTER_VAR_GH_CONFIG_DIR")).toBe(GITHUB_CLI_CONFIG_DIRECTORY);
  expect(dockerEnv("COMPUTER_VAR_GIT_CONFIG_GLOBAL")).toBe(GIT_GLOBAL_CONFIG_PATH);
});

test("every base image is pinned by digest", () => {
  const bases = [...dockerfile.matchAll(/^FROM (\S+)/gmu)].flatMap((match) =>
    match[1] === "computerd-source" ? [] : [match[1] ?? ""],
  );

  expect(bases.length).toBe(2);
  expect(bases.filter((image) => !/@sha256:[0-9a-f]{64}$/u.test(image))).toStrictEqual([]);
});

test("the build context admits every file the workspace image copies", () => {
  const admitted = new Set(
    Object.keys(contextFiles).map((path) => path.slice(BUILD_CONTEXT.length)),
  );

  const copied = [...dockerfile.matchAll(/^COPY (?!--from)(.+) \S+$/gmu)].flatMap(
    (match) => match[1]?.split(" ") ?? [],
  );

  expect(copied.length).toBeGreaterThan(0);
  expect(copied.filter((source) => !admitted.has(source))).toStrictEqual([]);
});
