import { expect, test } from "vitest";
import { placeholder } from "../src/index.js";

test("scaffold builds and runs", () => {
  expect(placeholder).toBe(true);
});
