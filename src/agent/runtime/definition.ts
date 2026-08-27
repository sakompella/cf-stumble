import { Result, TaggedError } from "better-result";
import { readGeneration, type LoadedGeneration } from "../../generation/read.js";
import type { CommitSnapshot } from "../../generation/types.js";
import type { Sha } from "../../git/types.js";
import type { StorageUnavailableError } from "../../storage/errors.js";
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
  readonly generation: CommitSnapshot;
  readonly systemPrompt: string;
  readonly policy: string;
  readonly skills: readonly AgentSkill[];
};

export class MissingModuleError extends TaggedError("MissingModuleError")<{
  path: string;
  message: string;
}> {
  constructor(args: { path: string }) {
    super({ ...args, message: `required module ${JSON.stringify(args.path)} is missing` });
  }
}

export type InvalidModuleReason = "empty-content" | "invalid-utf8";

export class InvalidModuleError extends TaggedError("InvalidModuleError")<{
  path: string;
  reason: InvalidModuleReason;
  message: string;
  cause?: unknown;
}> {
  constructor(args: { path: string; reason: InvalidModuleReason; cause?: unknown }) {
    const detail =
      args.reason === "empty-content"
        ? "required module content must not be empty"
        : "module content is not valid UTF-8";
    super({ ...args, message: `${JSON.stringify(args.path)}: ${detail}` });
  }
}

export type UnsupportedModuleReason = "not-under-skills-prefix" | "invalid-skill-filename";

export class UnsupportedModuleError extends TaggedError("UnsupportedModuleError")<{
  path: string;
  reason: UnsupportedModuleReason;
  message: string;
}> {
  constructor(args: { path: string; reason: UnsupportedModuleReason }) {
    const detail =
      args.reason === "not-under-skills-prefix"
        ? `module must be ${JSON.stringify(SYSTEM_PROMPT_PATH)}, ${JSON.stringify(POLICY_PATH)}, or under ${JSON.stringify(SKILLS_PREFIX)}`
        : `skill module must be a non-empty .md file directly under ${JSON.stringify(SKILLS_PREFIX)}`;
    super({ ...args, message: `${JSON.stringify(args.path)}: ${detail}` });
  }
}

/** Every way a candidate's own modules can fail to materialize into an `AgentDefinition`. */
export type AgentMaterializationError =
  | MissingModuleError
  | InvalidModuleError
  | UnsupportedModuleError;

export type MaterializeGenerationError = AgentMaterializationError | StorageUnavailableError;

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/**
 * Read and validate the role-bearing modules in one immutable generation.
 *
 * Module-shape failures describe the generation; storage failures describe the supervisor and
 * must reach its boundary without being recorded as a candidate failure.
 */
export async function materializeGeneration(
  store: Store,
  sha: Sha,
): Promise<Result<AgentDefinition, MaterializeGenerationError>> {
  const loaded = await readGeneration(store, sha);
  if (Result.isError(loaded)) {
    return loaded;
  }
  return materializeLoadedGeneration(loaded.value);
}

export const materializeAgent = materializeGeneration;

function materializeLoadedGeneration(
  loaded: LoadedGeneration,
): Result<AgentDefinition, AgentMaterializationError> {
  const byPath = new Map(loaded.modules.map((module) => [module.path, module]));
  const promptModule = byPath.get(SYSTEM_PROMPT_PATH);
  if (promptModule === undefined) {
    return Result.err(new MissingModuleError({ path: SYSTEM_PROMPT_PATH }));
  }
  const policyModule = byPath.get(POLICY_PATH);
  if (policyModule === undefined) {
    return Result.err(new MissingModuleError({ path: POLICY_PATH }));
  }

  const skills = materializeSkills(loaded.modules);
  if (Result.isError(skills)) {
    return skills;
  }
  const systemPrompt = requiredText(SYSTEM_PROMPT_PATH, promptModule.content);
  if (Result.isError(systemPrompt)) {
    return systemPrompt;
  }
  const policy = requiredText(POLICY_PATH, policyModule.content);
  if (Result.isError(policy)) {
    return policy;
  }

  return Result.ok({
    generation: loaded.generation,
    systemPrompt: systemPrompt.value,
    policy: policy.value,
    skills: skills.value,
  });
}

function materializeSkills(
  modules: LoadedGeneration["modules"],
): Result<AgentSkill[], AgentMaterializationError> {
  const skills: AgentSkill[] = [];
  for (const module of modules) {
    if (module.path === SYSTEM_PROMPT_PATH || module.path === POLICY_PATH) {
      continue;
    }
    if (!module.path.startsWith(SKILLS_PREFIX)) {
      return Result.err(
        new UnsupportedModuleError({ path: module.path, reason: "not-under-skills-prefix" }),
      );
    }
    const fileName = module.path.slice(SKILLS_PREFIX.length);
    if (fileName.length <= ".md".length || !fileName.endsWith(".md") || fileName.includes("/")) {
      return Result.err(
        new UnsupportedModuleError({ path: module.path, reason: "invalid-skill-filename" }),
      );
    }
    const content = decodeText(module.path, module.content);
    if (Result.isError(content)) {
      return content;
    }
    skills.push({ name: fileName.slice(0, -".md".length), content: content.value });
  }
  skills.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return Result.ok(skills);
}

function requiredText(
  path: string,
  content: Uint8Array,
): Result<string, AgentMaterializationError> {
  const decoded = decodeText(path, content);
  if (Result.isError(decoded)) {
    return decoded;
  }
  if (decoded.value.length === 0) {
    return Result.err(new InvalidModuleError({ path, reason: "empty-content" }));
  }
  return Result.ok(decoded.value);
}

function decodeText(path: string, content: Uint8Array): Result<string, InvalidModuleError> {
  return Result.try({
    try: () => decoder.decode(content),
    catch: (cause) => new InvalidModuleError({ path, reason: "invalid-utf8", cause }),
  });
}
