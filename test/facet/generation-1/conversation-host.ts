import type { ConversationHost } from "../../../src/facet/index.js";
import type { MainFacet } from "../../../src/facet/generation-1/main-facet.js";

export type AttachedHost = ConversationHost & Readonly<{ dup(): ConversationHost }>;

export function hostWith(overrides: Partial<ConversationHost> = {}): AttachedHost {
  const host: AttachedHost = {
    arm: () => Promise.resolve(),
    log: () => Promise.resolve(),
    running: () => Promise.resolve(),
    workspace: () => Promise.reject(new Error("no workspace")),
    ...overrides,
    dup: () => host,
  };

  return host;
}

export function entriesText(facet: MainFacet, id: string): Promise<string> {
  return facet.entries(id, {
    minEntryId: undefined,
    maxEntryId: undefined,
    order: "ascending",
    limit: 50,
  });
}
