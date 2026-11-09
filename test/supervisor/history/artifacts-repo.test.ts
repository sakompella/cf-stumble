import { expect, test } from "vitest";
import { artifactsHistory } from "../../../src/supervisor/history/artifacts-repo.js";

const commit = { message: "activated generation 0", files: { "events/1-activated.json": "{}" } };

function binding(pushed: boolean, existing: boolean) {
  const calls: string[] = [];

  const repo = {
    info: () =>
      Promise.resolve({
        remote: "https://remote.invalid/generations.git",
        lastPushAt: pushed ? "now" : null,
      }),
    createToken: (scope: string, seconds: number) => {
      calls.push(`token ${scope} ${seconds}`);

      return Promise.resolve({ plaintext: "art_secret?expires=1" });
    },
    [Symbol.dispose]: () => {
      calls.push("dispose");
    },
  };

  const artifacts = {
    get: () => (existing ? Promise.resolve(repo) : Promise.reject(new Error("not found"))),
    create: () => {
      calls.push("create");

      return Promise.resolve({
        remote: "https://remote.invalid/generations.git",
        token: "art_new?expires=1",
      });
    },
  };

  return { artifacts, calls };
}

type Options = Readonly<
  Record<string, string | readonly string[] | Readonly<Record<string, string>>>
>;

function fakeGit(calls: string[]) {
  const step = (name: string) => (options: Options) => {
    calls.push(`${name} ${JSON.stringify(options)}`);

    return Promise.resolve();
  };

  return () => ({
    init: step("init"),
    clone: step("clone"),
    add: step("add"),
    commit: (options: Options) => {
      calls.push(`commit ${JSON.stringify(options)}`);

      return Promise.resolve();
    },
    push: step("push"),
  });
}

test("the first write creates the repository, initialises and pushes with the new token", async () => {
  const { artifacts, calls } = binding(false, false);

  await artifactsHistory(artifacts, fakeGit(calls))(commit);

  expect(calls.map((call) => call.split(" ")[0])).toEqual([
    "create",
    "init",
    "add",
    "commit",
    "push",
  ]);
  expect(calls.at(-1)).toContain("Bearer art_new");
  expect(calls.at(-1)).not.toContain("expires");
});

test("a later write clones the pushed repository with a write token", async () => {
  const { artifacts, calls } = binding(true, true);

  await artifactsHistory(artifacts, fakeGit(calls))(commit);

  expect(calls.map((call) => call.split(" ")[0])).toEqual([
    "token",
    "dispose",
    "clone",
    "add",
    "commit",
    "push",
  ]);
  expect(calls.at(-1)).toContain("Bearer art_secret");
});
