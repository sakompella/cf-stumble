import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { resultOf } from "../../effect-result.js";
import { testHarnessCommit } from "../../harness-commit-fixtures.js";
import { encodeModuleMap } from "../../../src/supervisor/artifacts/module-map.js";
import { withArtifacts } from "./artifacts-fixture.js";
import { BuildHost, GatedBuildHost } from "./build-hosts.js";

const commits = {
  joined: testHarnessCommit("1000000000000000000000000000000000000006"),
  retried: testHarnessCommit("1000000000000000000000000000000000000007"),
  abandoned: testHarnessCommit("1000000000000000000000000000000000000008"),
} as const;

afterEach(async () => {
  await reset();
});

test("admits one build per commit, so a concurrent request joins it instead of racing it", async () => {
  const host = new GatedBuildHost();

  const outcome = await withArtifacts("prepare-joins-build-in-flight", host, async (artifacts) => {
    const first = resultOf(artifacts.prepare(commits.joined));
    const second = resultOf(artifacts.prepare(commits.joined));
    host.release();
    const [left, right] = await Promise.all([first, second]);

    if (Result.isFailure(left) || Result.isFailure(right)) {
      throw new Error("both callers must receive the one build's result");
    }

    return { left: encodeModuleMap(left.success), right: encodeModuleMap(right.success) };
  });

  expect(outcome.right).toBe(outcome.left);
  expect(
    host.inner.provisions(),
    "one build ran; the second caller started none of its own, because two builds of one commit share and clear one scratch directory",
  ).toBe(1);
});

test("builds again once the build in flight has failed", async () => {
  const host = new BuildHost();
  host.failing = "install";

  const outcome = await withArtifacts("prepare-retries-settled-build", host, async (artifacts) => {
    const failed = await resultOf(artifacts.prepare(commits.retried));
    host.failing = undefined;
    const retried = await resultOf(artifacts.prepare(commits.retried));

    return { failed: Result.isFailure(failed), retried: Result.isSuccess(retried) };
  });

  expect(outcome).toEqual({ failed: true, retried: true });
  expect(
    host.requests.filter(
      (request) => request.kind === "build-step" && request.step === "provision",
    ),
    "the join bounds concurrent builds; it does not keep a settled one",
  ).toHaveLength(2);
});

test("a caller that stops waiting neither stops the build in flight nor drops it", async () => {
  const host = new GatedBuildHost();

  const outcome = await withArtifacts("prepare-keeps-abandoned-build", host, async (artifacts) => {
    const abandoned = Effect.runFork(artifacts.prepare(commits.abandoned));
    await Effect.runPromise(Effect.yieldNow);
    await Effect.runPromise(Fiber.interrupt(abandoned));
    const askedBeforeJoin = host.asked;

    const joined = resultOf(artifacts.prepare(commits.abandoned));
    host.release();

    return { askedBeforeJoin, joined: Result.isSuccess(await joined) };
  });

  expect(outcome).toEqual({ askedBeforeJoin: 1, joined: true });
  expect(
    host.inner.provisions(),
    "the later caller joined the first build instead of starting another",
  ).toBe(1);
});
