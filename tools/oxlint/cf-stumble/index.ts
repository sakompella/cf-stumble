import { eslintCompatPlugin } from "@oxlint/plugins";

import { noCommentsRule } from "./rules/no-comments.ts";
import { noTypeScriptPrivateRpcMemberRule } from "./rules/no-typescript-private-rpc-member.ts";

const cfStumblePlugin = eslintCompatPlugin({
  meta: { name: "cf-stumble" },
  rules: {
    "no-comments": noCommentsRule,
    "no-typescript-private-rpc-member": noTypeScriptPrivateRpcMemberRule,
  },
});

export default cfStumblePlugin;
