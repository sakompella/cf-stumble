import { vi } from "vitest";

const GENERATION_STATE_WRITE = "UPDATE generation_state SET";

export function refuseGenerationStateWrites(storage: DurableObjectStorage): () => void {
  const exec = storage.sql.exec.bind(storage.sql);

  const refusing = vi
    .spyOn(storage.sql, "exec")
    .mockImplementation((query: string, ...bindings: SqlStorageValue[]) => {
      if (query.includes(GENERATION_STATE_WRITE)) {
        throw new Error("the storage refused the generation state write");
      }

      return exec(query, ...bindings);
    });

  return () => {
    refusing.mockRestore();
  };
}
