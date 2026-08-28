import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import {
  canonicalizeObservableEffects,
  compareObservableEffects,
  type ObservableEffects,
} from "../../src/replay/comparison.js";
import { persistedExamples } from "../support/hegel.js";
import type { PrimitiveCall, WorkspaceFile } from "../../src/replay/schema.js";

/**
 * A property layer over `comparison.test.ts`, which pins three hand-picked pairs. Replay's whole
 * verdict rests on this comparison — it is what tells a promotion decision that a candidate
 * reproduced recorded behaviour — so a false "equal" here would let a divergent candidate look
 * validated, and that is worth checking over generated effects rather than only three fixtures.
 */

const shortText = gs.text({ maxSize: 12 });
const paths = gs.sampledFrom(["README.md", "src/app.ts", "a", "b/c.txt"]);

const primitiveCalls = gs.composite<PrimitiveCall>((tc) => {
  const kind = tc.draw(gs.sampledFrom(["read", "write", "edit", "bash"] as const));
  switch (kind) {
    case "read":
      return { kind, path: tc.draw(paths) };
    case "write":
      return { kind, path: tc.draw(paths), content: tc.draw(shortText) };
    case "edit":
      return {
        kind,
        path: tc.draw(paths),
        oldText: tc.draw(shortText),
        newText: tc.draw(shortText),
      };
    case "bash":
      return { kind, command: tc.draw(shortText) };
    default:
      kind satisfies never;
      throw new Error("unreachable primitive call kind");
  }
});

// A workspace tree cannot hold one path twice — `parseReplaySession` rejects that before this
// module ever sees the value — so `finalWorkspace` is built from a deduplicated set of paths
// rather than drawn as an array of independent files, which could repeat one.
const workspaceTrees = gs.composite<readonly WorkspaceFile[]>((tc) => {
  const distinctPaths = [...new Set(tc.draw(gs.arrays(paths, { maxSize: 4 })))];
  return distinctPaths.map((path) => ({ path, content: tc.draw(shortText) }));
});

const observableEffects = gs.composite<ObservableEffects>((tc) => ({
  trace: tc.draw(gs.arrays(primitiveCalls, { maxSize: 5 })),
  finalWorkspace: tc.draw(workspaceTrees),
}));

test("comparing effects against themselves is always equal, in any final-workspace order", () => {
  hegel.test((tc) => {
    const effects = tc.draw(observableEffects);
    const reordered: ObservableEffects = {
      trace: effects.trace,
      finalWorkspace: effects.finalWorkspace.toReversed(),
    };

    expect(compareObservableEffects(effects, effects)).toEqual({ equal: true });
    expect(compareObservableEffects(effects, reordered)).toEqual({ equal: true });
    expect(canonicalizeObservableEffects(reordered)).toEqual(
      canonicalizeObservableEffects(effects),
    );
  }, persistedExamples);
});

/**
 * U+10FFFF is the highest Unicode code point there is, so a path built from it always sorts after
 * every path `paths` can draw, and no generated call or file can already equal it. That makes it a
 * marker for "definitely one more thing than before" without having to characterise what
 * "different" means for every call kind by hand.
 */
const SENTINEL_PATH = "\u{10FFFF}-marker";

test("appending an extra recorded call is always detected as a difference", () => {
  hegel.test((tc) => {
    const effects = tc.draw(observableEffects);
    const withExtraCall: ObservableEffects = {
      trace: [...effects.trace, { kind: "read", path: SENTINEL_PATH }],
      finalWorkspace: effects.finalWorkspace,
    };

    expect(compareObservableEffects(effects, withExtraCall)).toEqual({
      equal: false,
      difference: {
        kind: "trace",
        index: effects.trace.length,
        expected: undefined,
        actual: { kind: "read", path: SENTINEL_PATH },
      },
    });
  }, persistedExamples);
});

test("appending an extra workspace file is always detected as a difference", () => {
  hegel.test((tc) => {
    const effects = tc.draw(observableEffects);
    const withExtraFile: ObservableEffects = {
      trace: effects.trace,
      finalWorkspace: [...effects.finalWorkspace, { path: SENTINEL_PATH, content: "" }],
    };

    // The sentinel sorts after every generated path, so it lands exactly at the index the shorter
    // side runs out at, whatever order the rest of the workspace happened to be drawn in.
    expect(compareObservableEffects(effects, withExtraFile)).toEqual({
      equal: false,
      difference: {
        kind: "workspace",
        path: SENTINEL_PATH,
        expected: undefined,
        actual: { path: SENTINEL_PATH, content: "" },
      },
    });
  }, persistedExamples);
});
