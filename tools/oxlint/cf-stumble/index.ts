import { eslintCompatPlugin } from "@oxlint/plugins";

import { noTypeScriptPrivateRpcMemberRule } from "./rules/no-typescript-private-rpc-member.ts";

const cfStumblePlugin = eslintCompatPlugin({
  meta: { name: "cf-stumble" },
  rules: {
    "no-typescript-private-rpc-member": noTypeScriptPrivateRpcMemberRule,
  },
});

export default cfStumblePlugin;
