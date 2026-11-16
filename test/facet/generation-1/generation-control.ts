import {
  createComputerEnv,
  type ComputerEnvOptions,
} from "../../../src/facet/generation-1/execution-env.js";
import type { GenerationControl } from "../../../src/generation-requests.js";

export type AttachedGenerations = GenerationControl & Readonly<{ dup(): GenerationControl }>;

const notScripted = () => Promise.reject(new Error("not scripted"));

export const unscriptedGenerations: AttachedGenerations = {
  generationStatus: notScripted,
  submitGeneration: notScripted,
  prepareGeneration: notScripted,
  controlGeneration: notScripted,
  dup: () => unscriptedGenerations,
};

export function envWithoutGenerations(options: Omit<ComputerEnvOptions, "generations">) {
  return createComputerEnv({ ...options, generations: unscriptedGenerations });
}
