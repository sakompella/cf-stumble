/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

afterEach(async () => {
  await reset();
});

test("has no generation-control request journal in a fresh schema (ADR-0030)", async () => {
  const control = supervisor("control-no-request-journal");
  // Force schema creation (Generations, GenerationControl) before inspecting the Supervisor.
  await control.getActiveGeneration();

  const journalTable = await runInDurableObject(control, (_, state) =>
    state.storage.sql
      .exec<{ readonly name: string }>(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'generation_control_journal'",
      )
      .toArray()
      .map((row) => row.name),
  );

  expect(journalTable, "the journal ADR-0030 removed must not exist").toEqual([]);
});
