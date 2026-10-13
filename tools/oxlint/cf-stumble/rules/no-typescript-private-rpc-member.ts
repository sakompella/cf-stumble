import { defineRule } from "@oxlint/plugins";

import type { ESTree, Scope, SourceCode } from "@oxlint/plugins";

/** The `cloudflare:workers` classes whose subclasses Workers RPC exposes by prototype. */
const RPC_BASE_CLASSES = new Set(["DurableObject", "RpcTarget", "WorkerEntrypoint"]);

function importedName(specifier: ESTree.Node): string | undefined {
  if (specifier.type !== "ImportSpecifier") return undefined;

  return specifier.imported.type === "Identifier"
    ? specifier.imported.name
    : specifier.imported.value;
}

/** Whether `superClass` names an RPC base class imported from `cloudflare:workers`. */
function extendsRpcBase(sourceCode: SourceCode, superClass: ESTree.Expression | null): boolean {
  if (superClass?.type !== "Identifier") return false;

  for (
    let scope: Scope | null = sourceCode.getScope(superClass);
    scope !== null;
    scope = scope.upper
  ) {
    const variable = scope.set.get(superClass.name);

    if (variable === undefined) continue;

    return variable.defs.some(
      (definition) =>
        definition.type === "ImportBinding" &&
        definition.parent?.type === "ImportDeclaration" &&
        definition.parent.source.value === "cloudflare:workers" &&
        RPC_BASE_CLASSES.has(importedName(definition.node) ?? ""),
    );
  }

  return false;
}

/** Whether Workers RPC would expose `element` while TypeScript says only the class may call it. */
function isHiddenPrototypeMember(element: ESTree.ClassElement): boolean {
  if (element.type !== "MethodDefinition" && element.type !== "AccessorProperty") return false;

  if (element.static || (element.type === "MethodDefinition" && element.kind === "constructor")) {
    return false;
  }

  return element.accessibility === "private" || element.accessibility === "protected";
}

/**
 * Workers RPC exposes every method and accessor on the prototype of a class that extends
 * `WorkerEntrypoint`, `DurableObject`, or `RpcTarget`. TypeScript's `private` and `protected` are
 * erased, so a caller holding a stub can still call such a helper. A JavaScript `#private` method
 * is not on the prototype. Only a direct `extends` of an imported base class is recognised.
 */
export const noTypeScriptPrivateRpcMemberRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow TypeScript private and protected methods on Workers RPC classes; RPC exposes them.",
    },
    messages: {
      hiddenRpcMember:
        "Workers RPC exposes this {{accessibility}} method to every stub holder. Use a `#private` method or a module function for a helper.",
    },
  },
  createOnce(context) {
    function check(node: ESTree.Class): void {
      if (!extendsRpcBase(context.sourceCode, node.superClass)) return;

      for (const element of node.body.body) {
        if (isHiddenPrototypeMember(element) && "accessibility" in element) {
          context.report({
            node: element,
            messageId: "hiddenRpcMember",
            data: { accessibility: element.accessibility ?? "" },
          });
        }
      }
    }

    return { ClassDeclaration: check, ClassExpression: check };
  },
});
