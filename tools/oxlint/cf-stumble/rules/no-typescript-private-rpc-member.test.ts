import { RuleTester } from "oxlint/plugins-dev";

import { noTypeScriptPrivateRpcMemberRule } from "./no-typescript-private-rpc-member.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

const workers =
  'import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";\n';

function hidden(accessibility: "private" | "protected") {
  return { messageId: "hiddenRpcMember", data: { accessibility } };
}

tester.run("cf-stumble/no-typescript-private-rpc-member", noTypeScriptPrivateRpcMemberRule, {
  valid: [
    `${workers}class Route extends WorkerEntrypoint { run() { return this.#helper(); } #helper() { return 1; } }`,
    `${workers}class Host extends DurableObject { private readonly name = "host"; constructor(ctx: DurableObjectState, env: object) { super(ctx, env); } }`,
    `${workers}class Host extends DurableObject { private static label() { return "host"; } }`,
    `${workers}class Host extends DurableObject { public fetch() { return new Response(); } }`,
    "class Store { private read() { return 1; } }",
    "class Store extends Map { private read() { return 1; } }",
    "import { DurableObject } from './local.js'; class Host extends DurableObject { private read() { return 1; } }",
  ],
  invalid: [
    {
      name: "private method on a WorkerEntrypoint",
      code: `${workers}class Route extends WorkerEntrypoint<Env> { private credential() { return 1; } }`,
      errors: [hidden("private")],
    },
    {
      name: "protected method on a DurableObject",
      code: `${workers}export class Host extends DurableObject { protected mount() { return 1; } }`,
      errors: [hidden("protected")],
    },
    {
      name: "private getter and accessor on an RpcTarget expression",
      code: `${workers}const Target = class extends RpcTarget { private get token() { return ""; } private accessor count = 0; };`,
      errors: [hidden("private"), hidden("private")],
    },
    {
      name: "aliased import",
      code: 'import { DurableObject as Base } from "cloudflare:workers"; class Host extends Base { private read() { return 1; } }',
      errors: [hidden("private")],
    },
  ],
});
