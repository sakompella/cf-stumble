import type { AccessIdentity } from "./access/index.js";
import { resolveProject, type Project, type ProjectCatalog } from "./project-catalog.js";

export const HARNESS_BUILD_WORKSPACE_NAME = "harness-build-workspace";

export interface DeriveProjectWorkspaceNameInput {
  readonly identity: AccessIdentity;
  readonly audience: string;
  readonly project: Project;
}

export async function deriveProjectWorkspaceName(
  input: DeriveProjectWorkspaceNameInput,
  webCrypto: Crypto = crypto,
): Promise<string> {
  const value = new TextEncoder().encode(
    `${input.identity}\u0000${input.audience}\u0000${input.project.id}`,
  );
  const digest = await webCrypto.subtle.digest("SHA-256", value);
  const bytes = new Uint8Array(digest);
  const hash = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `access:${hash}`;
}

export type ProjectWorkspaceResolution =
  | Readonly<{ ok: true; project: Project; workspaceName: string }>
  | Readonly<{ ok: false; reason: "invalid-project-id" | "unknown-project-id" }>;

export interface ResolveProjectWorkspaceNameInput {
  readonly identity: AccessIdentity;
  readonly audience: string;
  readonly projectId: unknown;
  readonly catalog?: ProjectCatalog;
}

export async function resolveProjectWorkspaceName(
  input: ResolveProjectWorkspaceNameInput,
  webCrypto: Crypto = crypto,
): Promise<ProjectWorkspaceResolution> {
  const projectResolution = resolveProject(input.projectId, input.catalog);
  if (!projectResolution.ok) {
    return projectResolution;
  }

  return {
    ok: true,
    project: projectResolution.project,
    workspaceName: await deriveProjectWorkspaceName(
      {
        identity: input.identity,
        audience: input.audience,
        project: projectResolution.project,
      },
      webCrypto,
    ),
  };
}
