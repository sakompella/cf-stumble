import { createRegistry, type Registry } from "@earendil-works/pi-durable";
import { CodingTools } from "./coding-tools.js";
import { CfStumblePrompt } from "./prompt.js";
import { RepeatedCallNote } from "./repeated-call-note.js";
import { RunNotices } from "./run-notices.js";

export function harnessRegistry(): Registry {
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(CfStumblePrompt);
  registry.install(RunNotices);
  registry.install(RepeatedCallNote);

  return registry;
}
