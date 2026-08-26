import { readGeneration, type LoadedGeneration } from "../../generation/read.js";
import type { Generation } from "../../generation/types.js";
import type { Sha } from "../../git/types.js";
import type { Store } from "../../storage/types.js";

/** The generation manifest convention consumed by the runtime. */
export const SYSTEM_PROMPT_PATH = "prompt.md";
export const POLICY_PATH = "policy.md";
export const SKILLS_PREFIX = "skills/";
export const AGENT_MANIFEST = {
  systemPrompt: SYSTEM_PROMPT_PATH,
  policy: POLICY_PATH,
  skillsPrefix: SKILLS_PREFIX,
} as const;

export type AgentSkill = {
  readonly name: string;
  readonly content: string;
};

export type AgentDefinition = {
  readonly generation: Generation;
  readonly systemPrompt: string;
  readonly policy: string;
  readonly skills: readonly AgentSkill[];
};

export type AgentMaterializationErrorKind =
  | "missing-module"
  | "invalid-module"
  | "unsupported-module";

export class AgentMaterializationError extends Error {
  readonly kind: AgentMaterializationErrorKind;
  readonly path: string;

  constructor(kind: AgentMaterializationErrorKind, path: string, message: string, cause?: unknown) {
    const fullMessage = `agent materialization error at ${JSON.stringify(path)}: ${message}`;
    if (cause === undefined) {
      super(fullMessage);
    } else {
      super(fullMessage, { cause });
    }
    this.name = "AgentMaterializationError";
    this.kind = kind;
    this.path = path;
  }
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** Read and validate the role-bearing modules in one immutable generation. */
export async function materializeGeneration(
  store: Store,
  sha: Sha,
): Promise<AgentDefinition> {
  const loaded = await readGeneration(store, sha);
  return materializeLoadedGeneration(loaded);
}

export const materializeAgent = materializeGeneration;

function materializeLoadedGeneration(loaded: LoadedGeneration): AgentDefinition {
  const byPath = new Map(loaded.modules.map((module) => [module.path, module]));
  const promptModule = byPath.get(SYSTEM_PROMPT_PATH);
  if (promptModule === undefined) {
    throw new AgentMaterializationError(
      "missing-module",
      SYSTEM_PROMPT_PATH,
      `required module ${JSON.stringify(SYSTEM_PROMPT_PATH)} is missing`,
    );
  }
  const policyModule = byPath.get(POLICY_PATH);
  if (policyModule === undefined) {
    throw new AgentMaterializationError(
      "missing-module",
      POLICY_PATH,
      `required module ${JSON.stringify(POLICY_PATH)} is missing`,
    );
  }

  const skills = materializeSkills(loaded.modules);
  return {
    generation: loaded.generation,
    systemPrompt: requiredText(SYSTEM_PROMPT_PATH, promptModule.content),
    policy: requiredText(POLICY_PATH, policyModule.content),
    skills,
  };
}

function materializeSkills(
  modules: LoadedGeneration["modules"],
): AgentSkill[] {
  const skills: AgentSkill[] = [];
  for (const module of modules) {
    if (module.path === SYSTEM_PROMPT_PATH || module.path === POLICY_PATH) {
      continue;
    }
    if (!module.path.startsWith(SKILLS_PREFIX)) {
      throw new AgentMaterializationError(
        "unsupported-module",
        module.path,
        `module must be ${JSON.stringify(SYSTEM_PROMPT_PATH)}, ${JSON.stringify(POLICY_PATH)}, or under ${JSON.stringify(SKILLS_PREFIX)}`,
      );
    }
    const fileName = module.path.slice(SKILLS_PREFIX.length);
    if (fileName.length <= ".md".length || !fileName.endsWith(".md") || fileName.includes("/")) {
      throw new AgentMaterializationError(
        "unsupported-module",
        module.path,
        `skill module must be a non-empty .md file directly under ${JSON.stringify(SKILLS_PREFIX)}`,
      );
    }
    skills.push({
      name: fileName.slice(0, -".md".length),
      content: decodeText(module.path, module.content),
    });
  }
  skills.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return skills;
}

function requiredText(path: string, content: Uint8Array): string {
  const text = decodeText(path, content);
  if (text.length === 0) {
    throw new AgentMaterializationError(
      "invalid-module",
      path,
      "required module content must not be empty",
    );
  }
  return text;
}

function decodeText(path: string, content: Uint8Array): string {
  try {
    return decoder.decode(content);
  } catch (error: unknown) {
    throw new AgentMaterializationError(
      "invalid-module",
      path,
      "module content is not valid UTF-8",
      error,
    );
  }
}
