import { expect, test } from "vitest";
import { MAX_LIST_BYTES, MAX_LIST_ENTRIES } from "../../../src/workspace/project/protocol.js";
import { encode, makeTarget } from "./target-helpers.js";

function directoryOf(names: readonly string[]) {
  const context = makeTarget();
  context.provider.addDirectory("/workspace/dir");

  for (const name of names) context.provider.addFile(`/workspace/dir/${name}`, encode("x"));

  return context.target;
}

async function listed(target: ReturnType<typeof directoryOf>) {
  const result = await target.listFiles("/dir");

  if (!result.ok) throw new Error(`listFiles failed: ${result.error.code}`);

  return result.value;
}

test("a directory within both bounds lists whole and is not truncated", async () => {
  const listing = await listed(directoryOf(["b.txt", "a.txt"]));

  expect(listing.entries.map((entry) => entry.name)).toEqual(["a.txt", "b.txt"]);
  expect(listing.truncated).toBe(false);
});

test("a directory over the entry bound lists the first names in order and says it was cut", async () => {
  const names = Array.from(
    { length: MAX_LIST_ENTRIES + 5 },
    (_, i) => `f${String(i).padStart(5, "0")}`,
  );

  const listing = await listed(directoryOf(names));

  expect(listing.entries.map((entry) => entry.name)).toEqual(names.slice(0, MAX_LIST_ENTRIES));
  expect(listing.truncated).toBe(true);
});

test("a directory over the byte bound is cut before the entry bound and says so", async () => {
  const names = Array.from(
    { length: 300 },
    (_, i) => `${String(i).padStart(3, "0")}${"n".repeat(250)}`,
  );

  const listing = await listed(directoryOf(names));

  const bytes = listing.entries.reduce(
    (sum, entry) => sum + new TextEncoder().encode(entry.path).length,
    0,
  );

  expect(listing.entries.length).toBeLessThan(MAX_LIST_ENTRIES);
  expect(listing.entries.length).toBeGreaterThan(0);
  expect(bytes).toBeLessThanOrEqual(MAX_LIST_BYTES);
  expect(listing.truncated).toBe(true);
});
