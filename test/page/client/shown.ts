import { freshThreadWording } from "../../../src/page/client/fresh-thread.js";
import type { Model } from "../../../src/page/client/model.js";
import { streamWording } from "../../../src/page/client/stream-phase.js";

export const freshShown = (model: Model): string => freshThreadWording(model.freshThread);

export const streamShown = (model: Model): string => streamWording(model.streamPhase);
