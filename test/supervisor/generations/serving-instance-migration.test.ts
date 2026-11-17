import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { FACET_COMPATIBILITY } from "../../../src/facet/runtime-contract.js";
import { Generations } from "../../../src/supervisor/generations.js";
import { spyPorts } from "./generation-ports.js";

afterEach(async () => {
  await reset();
});

const BEFORE_THE_COLUMN = `
  DROP TABLE generation_state;
  DROP TABLE generations;
  CREATE TABLE generations (
    label INTEGER PRIMARY KEY CHECK (label >= 0),
    harness_commit TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('candidate', 'ready', 'failed')),
    was_active INTEGER NOT NULL DEFAULT 0 CHECK (was_active IN (0, 1)),
    facet_compatibility TEXT
  );
  CREATE TABLE generation_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    active_label INTEGER REFERENCES generations(label),
    proven_label INTEGER REFERENCES generations(label)
      CHECK (proven_label IS NULL OR active_label IS NOT NULL),
    epoch INTEGER NOT NULL CHECK (epoch >= 0)
  );
  INSERT INTO generation_state (singleton, active_label, proven_label, epoch)
  VALUES (1, NULL, NULL, 4);
`;

test("a Supervisor that kept its serving instance in KV starts with that number in the selection", async () => {
  const outcome = await runInDurableObject(
    env.SUPERVISOR.getByName("instance-moves"),
    (_i, state) => {
      state.storage.sql.exec(BEFORE_THE_COLUMN);
      state.storage.kv.put("serving-instance", 5);

      const first = new Generations(state.storage, FACET_COMPATIBILITY, spyPorts());
      const again = new Generations(state.storage, FACET_COMPATIBILITY, spyPorts());

      return {
        instance: first.servingInstance(),
        later: again.servingInstance(),
        epoch: first.active().epoch,
        key: state.storage.kv.get("serving-instance"),
      };
    },
  );

  expect(outcome).toEqual({ instance: 5, later: 5, epoch: 4, key: undefined });
});
