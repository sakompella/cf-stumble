import { eslintCompatPlugin } from "@oxlint/plugins";

import { noTypeScriptPrivateRpcMemberRule } from "./rules/no-typescript-private-rpc-member.ts";

/** Rules for this project's own invariants, beside the vendored generic plugins. */
const cfStumblePlugin = eslintCompatPlugin({
  meta: { name: "cf-stumble" },
  rules: {
    "no-typescript-private-rpc-member": noTypeScriptPrivateRpcMemberRule,
  },
});

export default cfStumblePlugin;
