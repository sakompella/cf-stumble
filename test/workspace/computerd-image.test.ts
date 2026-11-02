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

const patches = import.meta.glob("../../containers/*.patch", {
  eager: true,
  query: "?raw",
  import: "default",
});

const dockerfile = Object.values(dockerfiles).at(0) ?? "";

const dockerignore = Object.values(dockerignores).at(0) ?? "";

const dockerEnv = (name: string) => new RegExp(`^ENV ${name}=(\\S*)$`, "mu").exec(dockerfile)?.[1];

test("the workspace image's shim skips exactly the segments the sync ignores", () => {
  const setting = /^ENV COMPUTERD_WALK_IGNORE=(\S*)$/mu.exec(dockerfile)?.[1];

  expect(setting?.split(",")).toStrictEqual([...WORKSPACE_SYNC_IGNORES]);
});

test("the workspace image polls the disk every five seconds, not every 250 ms", () => {
  const setting = /^ENV COMPUTERD_POLL_MS=(\S*)$/mu.exec(dockerfile)?.[1];

  expect(setting).toBe("5000");
});

test("the workspace image keeps gh and Git global configuration in the durable workspace", () => {
  expect(dockerEnv("COMPUTER_VAR_GH_CONFIG_DIR")).toBe(GITHUB_CLI_CONFIG_DIRECTORY);
  expect(dockerEnv("COMPUTER_VAR_GIT_CONFIG_GLOBAL")).toBe(GIT_GLOBAL_CONFIG_PATH);
});

test("the workspace image does not ship the prebuilt computerd image", () => {
  expect(dockerfile).not.toMatch(/^FROM ghcr\.io\/cloudflare\/computer-computerd/mu);
});

test("the image build applies every patch and runs the tests the patches carry", () => {
  const vitestTargets = /npx vitest run ([^)]+)\)/u.exec(dockerfile)?.[1]?.split(" ") ?? [];

  expect(Object.keys(patches).length).toBeGreaterThan(0);

  for (const [path, source] of Object.entries(patches)) {
    const name = path.split("/").at(-1) ?? path;

    const carriedTests = [
      ...source.matchAll(/^\+\+\+ b\/packages\/computerd\/(\S+\.test\.ts)$/gmu),
    ];

    expect(dockerfile, `${name} is copied into the build`).toContain(
      `COPY containers/${name} /tmp/${name}`,
    );
    expect(dockerfile, `${name} is applied`).toContain(`git apply /tmp/${name}`);
    expect(carriedTests.length, `${name} carries a test`).toBeGreaterThan(0);

    for (const [, testFile = ""] of carriedTests) {
      expect(
        vitestTargets.some((target) => testFile.startsWith(target)),
        `${testFile} is run by the image build`,
      ).toBe(true);
    }
  }
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
