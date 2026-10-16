import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { expect, test } from "vitest";
import { ModelRoute } from "../src/model-route.js";
import { ProjectRpcTarget } from "../src/workspace/project/index.js";

/**
 * Workers RPC exposes every method and accessor on the prototype chain of an RPC class, including
 * a TypeScript `private` one. A generation reaches `ModelRoute` through its `MODEL` binding and
 * `ProjectRpcTarget` through the project capability, so a new public member is a new capability
 * for mutable code. Adding one must also add its name here, on purpose. See ADR-0047.
 */

type Prototype = NonNullable<ReturnType<typeof Reflect.getPrototypeOf>>;

const BASE_PROTOTYPES: readonly Prototype[] = [
  Object.prototype,
  RpcTarget.prototype,
  WorkerEntrypoint.prototype,
];

function rpcMemberNames(prototype: Prototype): string[] {
  const names = new Set<string>();

  for (
    let current: Prototype | null = prototype;
    current !== null && !BASE_PROTOTYPES.includes(current);
    current = Reflect.getPrototypeOf(current)
  ) {
    for (const name of Object.getOwnPropertyNames(current)) names.add(name);
  }

  names.delete("constructor");

  return [...names].toSorted();
}

test("ModelRoute exposes exactly the allowlisted RPC members", () => {
  expect(rpcMemberNames(ModelRoute.prototype)).toStrictEqual(["runStream"]);
});

test("ProjectRpcTarget exposes exactly the allowlisted RPC members", () => {
  expect(rpcMemberNames(ProjectRpcTarget.prototype)).toStrictEqual([
    "endTurn",
    "kill",
    "listFiles",
    "lstat",
    "readFile",
    "startExec",
    "writeFile",
  ]);
});
