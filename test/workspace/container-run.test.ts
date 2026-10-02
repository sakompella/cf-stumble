import { expect, test } from "vitest";
import { ContainerLifecycle } from "../../src/workspace/container-lifecycle.js";

test("the first connect and a reconnect to the same runtime are not replacements", () => {
  const lifecycle = new ContainerLifecycle();
  lifecycle.connected("run-1");
  lifecycle.connected("run-1");

  expect(lifecycle.generation).toBe(0);
});

test("a connect to a different runtime is a replacement", () => {
  const lifecycle = new ContainerLifecycle();
  lifecycle.connected("run-1");
  lifecycle.connected("run-2");

  expect(lifecycle.generation).toBe(1);
});

test("a status read that shows a replacement bumps the generation", () => {
  const lifecycle = new ContainerLifecycle();
  lifecycle.replaced();

  expect(lifecycle.generation).toBe(1);
});

test("after the Host stops the container on purpose, the next runtime is not a replacement", () => {
  const lifecycle = new ContainerLifecycle();
  lifecycle.connected("run-1");
  lifecycle.stoppedByHost();
  lifecycle.connected("run-2");

  expect(lifecycle.generation, "the first exec after an idle stop must not report a restart").toBe(
    0,
  );

  lifecycle.connected("run-3");
  expect(lifecycle.generation, "a later change still counts").toBe(1);
});
