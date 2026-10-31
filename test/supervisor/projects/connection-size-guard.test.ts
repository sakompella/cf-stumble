import { reset } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { FAKE_TOKEN, NOW, REPOSITORY, tenant } from "./connection-tenant.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

test("refuses a repository that exceeds the durable workspace size budget before cloning", async () => {
  const subject = tenant("repository-too-large", {
    fallbackToken: FAKE_TOKEN,
    replies: [
      { size: 6_000_000, default_branch: "main" },
      { truncated: false, tree: [] },
    ],
  });

  const refused = await subject.connections((connections) =>
    connections.connect(REPOSITORY, undefined, NOW),
  );

  expect(refused).toMatchObject({ ok: false, problem: { code: "repository-too-large" } });
  expect(subject.workspace.commands.filter((command) => command.includes("git clone"))).toEqual([]);
});

test("allows a measured repository within both workspace limits", async () => {
  const subject = tenant("repository-size-allowed", {
    fallbackToken: FAKE_TOKEN,
    replies: [
      { size: 4_999_999, default_branch: "main" },
      { truncated: false, tree: [{ type: "blob", size: 100 }] },
    ],
  });

  const connected = await subject.connections((connections) =>
    connections.connect(REPOSITORY, undefined, NOW),
  );

  expect(connected).toMatchObject({ ok: true });
});

test("skips the size guard when GitHub metadata is unavailable", async () => {
  const subject = tenant("repository-size-skipped", {
    fallbackToken: FAKE_TOKEN,
    replies: [{ message: "rate limit exceeded" }],
  });

  const connected = await subject.connections((connections) =>
    connections.connect(REPOSITORY, undefined, NOW),
  );

  expect(connected).toMatchObject({ ok: true });
});

test("refuses a repository whose tree response is truncated", async () => {
  const subject = tenant("repository-tree-truncated", {
    fallbackToken: FAKE_TOKEN,
    replies: [
      { size: 1, default_branch: "main" },
      { truncated: true, tree: [{ type: "blob", size: 100 }] },
    ],
  });

  const refused = await subject.connections((connections) =>
    connections.connect(REPOSITORY, undefined, NOW),
  );

  expect(refused).toMatchObject({ ok: false, problem: { code: "repository-too-large" } });
  expect(subject.workspace.commands).toEqual([]);
});

test("refuses a repository whose tree exceeds the file-count limit", async () => {
  const subject = tenant("repository-file-count", {
    fallbackToken: FAKE_TOKEN,
    replies: [
      { size: 1, default_branch: "main" },
      { truncated: false, tree: Array.from({ length: 3_001 }, () => ({ type: "blob", size: 1 })) },
    ],
  });

  const refused = await subject.connections((connections) =>
    connections.connect(REPOSITORY, undefined, NOW),
  );

  expect(refused).toMatchObject({ ok: false, problem: { code: "repository-too-large" } });
  expect(subject.workspace.commands).toEqual([]);
});

test("refuses a repository whose working tree exceeds the byte limit", async () => {
  const subject = tenant("repository-working-tree-bytes", {
    fallbackToken: FAKE_TOKEN,
    replies: [
      { size: 1, default_branch: "main" },
      { truncated: false, tree: [{ type: "blob", size: 150_000_001 }] },
    ],
  });

  const refused = await subject.connections((connections) =>
    connections.connect(REPOSITORY, undefined, NOW),
  );

  expect(refused).toMatchObject({ ok: false, problem: { code: "repository-too-large" } });
  expect(subject.workspace.commands).toEqual([]);
});

test("allows a repository exactly at the file and working-tree byte limits", async () => {
  const subject = tenant("repository-size-boundaries", {
    fallbackToken: FAKE_TOKEN,
    replies: [
      { size: 4_999_999, default_branch: "main" },
      {
        truncated: false,
        tree: Array.from({ length: 3_000 }, (_, index) => ({
          type: "blob",
          size: index === 2_999 ? 150_000_000 - 2_999 : 1,
        })),
      },
    ],
  });

  await expect(
    subject.connections((connections) => connections.connect(REPOSITORY, undefined, NOW)),
  ).resolves.toMatchObject({ ok: true });
});
