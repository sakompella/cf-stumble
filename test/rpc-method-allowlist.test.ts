import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { expect, test } from "vitest";
import { ModelRoute } from "../src/model-route.js";
import { ProjectRpcTarget } from "../src/workspace/project/index.js";
import { ConversationHostTarget } from "../src/supervisor/conversations/host-target.js";

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
    "lstat",
    "readFile",
    "startExec",
    "writeFile",
  ]);
});

test("the host a serving facet holds exposes exactly the allowlisted RPC members", () => {
  expect(rpcMemberNames(ConversationHostTarget.prototype)).toStrictEqual([
    "arm",
    "running",
    "workspace",
  ]);
});
