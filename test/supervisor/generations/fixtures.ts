import { isGenerationLabel, type GenerationLabel } from "../../../src/supervisor/generations.js";

export function label(value: number): GenerationLabel {
  if (!isGenerationLabel(value)) throw new Error(`invalid test label ${value}`);

  return value;
}

export { testHarnessCommit } from "../../harness-commit-fixtures.js";
