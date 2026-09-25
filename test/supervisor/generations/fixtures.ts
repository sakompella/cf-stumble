import {
  parseGenerationLabel,
  type GenerationLabel,
} from "../../../src/supervisor/generations/index.js";

export function label(value: number): GenerationLabel {
  const parsed = parseGenerationLabel(value);

  if (parsed === undefined) {
    throw new Error(`invalid test label ${value}`);
  }

  return parsed;
}
