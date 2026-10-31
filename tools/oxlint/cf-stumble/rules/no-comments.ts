import { defineRule } from "@oxlint/plugins";

export const noCommentsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow every comment, including lint and TypeScript directives; rewrite the code instead.",
    },
    messages: {
      comment:
        "Remove this comment. Rewrite the code so it needs neither an explanation nor a directive.",
    },
  },
  createOnce(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type !== "Shebang")
            context.report({ loc: comment.loc, messageId: "comment" });
        }
      },
    };
  },
});
