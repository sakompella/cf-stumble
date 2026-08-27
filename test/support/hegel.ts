import { Database, type Settings } from "@hegeldev/hegel";

/** Store shrunk failures locally so the next Node run replays them before generating new cases. */
export const persistedExamples = {
  database: Database.fromPath(".hegel"),
} satisfies Partial<Settings>;
