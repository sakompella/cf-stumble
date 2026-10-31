import { RuleTester } from "oxlint/plugins-dev";

import { noCommentsRule } from "./no-comments.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

const comment = { messageId: "comment" };

tester.run("cf-stumble/no-comments", noCommentsRule, {
  valid: [
    "#!/usr/bin/env node\nexport const answer = 42;",
    'export const url = "https://example.com/a//b";',
    "export const pattern = /\\/\\/ not a comment/u;",
    "export const shell = `# planned shell ${1} // stays a string`;",
  ],
  invalid: [
    { name: "line comment", code: "// note\nexport const answer = 42;", errors: [comment] },
    { name: "trailing comment", code: "export const answer = 42; // note", errors: [comment] },
    { name: "block comment", code: "export const answer = /* note */ 42;", errors: [comment] },
    { name: "doc comment", code: "/** Answer. */\nexport const answer = 42;", errors: [comment] },
    {
      name: "TypeScript directive",
      code: "// @ts-check\nexport const answer = 42;",
      errors: [comment],
    },
    { name: "triple-slash reference", code: '/// <reference types="node" />', errors: [comment] },
  ],
});
