/// <reference types="@cloudflare/workers-types" />

import { WorkerEntrypoint } from "cloudflare:workers";

/** The only model selected by the immutable host. */
export const MODEL = "@cf/zai-org/glm-5.3-flash" as const;
const REASONING_EFFORT = "low" as const;
const SYSTEM_PROMPT = "You are a coding assistant." as const;

export type ModelRequest = Readonly<{ prompt: string }>;
export type ModelResult = object;
export type FixedModelInput = Readonly<{
  messages: readonly [
    Readonly<{ role: "system"; content: string }>,
    Readonly<{ role: "user"; content: string }>,
  ];
  reasoning_effort: "low";
}>;

export type ModelInference = {
  run(model: string, input: FixedModelInput): Promise<ModelResult>;
};

export type ModelRouteError = Readonly<{ code: "model-unavailable" }>;
export type ModelRouteResult =
  | Readonly<{ ok: true; result: ModelResult }>
  | Readonly<{ ok: false; error: ModelRouteError }>;

type ModelRouteEnv = Readonly<{ AI: Ai }>;

export function fixedModelInput(prompt: string): FixedModelInput {
  return {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    reasoning_effort: REASONING_EFFORT,
  };
}

/**
 * Calls the platform binding with the immutable route and payload. Provider
 * errors are intentionally replaced before they can cross the host boundary.
 */
export async function invokeFixedModel(
  ai: ModelInference,
  prompt: string,
): Promise<ModelRouteResult> {
  try {
    return { ok: true, result: await ai.run(MODEL, fixedModelInput(prompt)) };
  } catch {
    return { ok: false, error: { code: "model-unavailable" } };
  }
}

export class ModelRoute extends WorkerEntrypoint<ModelRouteEnv> {
  run(request: ModelRequest): Promise<ModelRouteResult> {
    return invokeFixedModel(
      {
        run: async (model, input) => structuredClone(await this.env.AI.run(model, input)),
      },
      request.prompt,
    );
  }
}
