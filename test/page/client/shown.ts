import { freshThreadWording } from "../../../src/page/client/fresh-thread.js";
import type { Model } from "../../../src/page/client/model.js";
import { streamWording } from "../../../src/page/client/stream-phase.js";
import { transcriptOf } from "../../../src/page/client/transcript.js";

export const freshShown = (model: Model): string => freshThreadWording(model.freshThread);

export const streamShown = (model: Model): string => streamWording(model.streamPhase);

export function whoShown(model: Model): readonly string[] {
  return transcriptOf(model.conversation, model.outgoing, "repo").map((entry) =>
    entry._tag === "Text" ? entry.who : entry._tag,
  );
}
