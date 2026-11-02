import { RuleTester } from "oxlint/plugins-dev";

import { noCommentsRule } from "./no-comments.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

const comment = { messageId: "comment" };

tester.run("cf-stumble/no-comments", noCommentsRule, {
  valid: [
    "#!/usr/bin/env node\nexport const answer = 42;",
    "export const shell = `# planned shell ${1} // stays a string`;",
  ],
  invalid: [
    { name: "line comment", code: "// note\nexport const answer = 42;", errors: [comment] },
    { name: "block comment", code: "export const answer = /* note */ 42;", errors: [comment] },
    {
      name: "TypeScript directive",
      code: "// @ts-check\nexport const answer = 42;",
      errors: [comment],
    },
  ],
});
