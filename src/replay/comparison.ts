import type { ObservableEffects, PrimitiveCall, WorkspaceFile } from "./schema.js";

export type { ObservableEffects } from "./schema.js";

export type EffectsDifference =
  | {
      readonly kind: "trace";
      readonly index: number;
      readonly expected: PrimitiveCall | undefined;
      readonly actual: PrimitiveCall | undefined;
    }
  | {
      readonly kind: "workspace";
      readonly path: string;
      readonly expected: WorkspaceFile | undefined;
      readonly actual: WorkspaceFile | undefined;
    };

export type EffectsComparison =
  | { readonly equal: true }
  | { readonly equal: false; readonly difference: EffectsDifference };

function comparePaths(left: WorkspaceFile, right: WorkspaceFile): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function canonicalWorkspace(files: readonly WorkspaceFile[]): WorkspaceFile[] {
  return files.toSorted(comparePaths);
}

function callsEqual(expected: PrimitiveCall, actual: PrimitiveCall): boolean {
  if (expected.kind !== actual.kind) {
    return false;
  }
  switch (expected.kind) {
    case "read":
      return actual.kind === "read" && expected.path === actual.path;
    case "write":
      return (
        actual.kind === "write" &&
        expected.path === actual.path &&
        expected.content === actual.content
      );
    case "edit":
      return (
        actual.kind === "edit" &&
        expected.path === actual.path &&
        expected.oldText === actual.oldText &&
        expected.newText === actual.newText
      );
    case "bash":
      return actual.kind === "bash" && expected.command === actual.command;
  }
  return false;
}

function filesEqual(expected: WorkspaceFile, actual: WorkspaceFile): boolean {
  return expected.path === actual.path && expected.content === actual.content;
}

/** Return the effect representation with deterministic ordering for content trees. */
export function canonicalizeObservableEffects(
  effects: ObservableEffects,
): ObservableEffects {
  return {
    trace: [...effects.trace],
    finalWorkspace: canonicalWorkspace(effects.finalWorkspace),
  };
}

export function compareObservableEffects(
  expected: ObservableEffects,
  actual: ObservableEffects,
): EffectsComparison {
  const canonicalExpected = canonicalizeObservableEffects(expected);
  const canonicalActual = canonicalizeObservableEffects(actual);

  const traceLength = Math.max(canonicalExpected.trace.length, canonicalActual.trace.length);
  for (let index = 0; index < traceLength; index += 1) {
    const expectedCall = canonicalExpected.trace[index];
    const actualCall = canonicalActual.trace[index];
    if (
      expectedCall === undefined ||
      actualCall === undefined ||
      !callsEqual(expectedCall, actualCall)
    ) {
      return {
        equal: false,
        difference: { kind: "trace", index, expected: expectedCall, actual: actualCall },
      };
    }
  }

  const expectedWorkspace = canonicalExpected.finalWorkspace;
  const actualWorkspace = canonicalActual.finalWorkspace;
  const workspaceLength = Math.max(expectedWorkspace.length, actualWorkspace.length);
  for (let index = 0; index < workspaceLength; index += 1) {
    const expectedFile = expectedWorkspace[index];
    const actualFile = actualWorkspace[index];
    if (
      expectedFile === undefined ||
      actualFile === undefined ||
      !filesEqual(expectedFile, actualFile)
    ) {
      return {
        equal: false,
        difference: {
          kind: "workspace",
          path: expectedFile?.path ?? actualFile?.path ?? "",
          expected: expectedFile,
          actual: actualFile,
        },
      };
    }
  }

  return { equal: true };
}
